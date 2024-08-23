const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { warn } = require('console');
const fs = require('fs').promises;
const path = require('path');

app.use(express.json());
app.use(express.static('public'));

const registeredUsers = new Map();
const buzzerPresses = [];
let buzzerPressed = false;
const adminPassword = process.env.ADMIN_PASSWORD || 'secret';
const stateFilePath = path.join(__dirname, 'appState.json');

function getTeamByName(teamName) {
    return Array.from(registeredUsers.values()).find(team => team.teamName === teamName);
}

function checkAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'No credentials sent!' });
    }

    const encodedCredentials = authHeader.split(' ')[1];
    const decodedCredentials = Buffer.from(encodedCredentials, 'base64').toString('ascii');
    const [username, password] = decodedCredentials.split(':');

    if (username === 'admin' && bcrypt.compareSync(password, bcrypt.hashSync(adminPassword, 10))) {
        next(); // Proceed to the next middleware or route handler
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
}

async function saveState() {
    const state = {
        registeredUsers: Array.from(registeredUsers.entries()),
        buzzerPresses,
        buzzerPressed
    };
    await fs.writeFile(stateFilePath, JSON.stringify(state, null, 2));
}

async function loadState() {
    try {
        const data = await fs.readFile(stateFilePath, 'utf8');
        const state = JSON.parse(data);
        state.registeredUsers.forEach(([key, value]) => registeredUsers.set(key, value));
        buzzerPresses.push(...state.buzzerPresses);
        buzzerPressed = state.buzzerPressed;
        console.log('State loaded successfully');
    } catch (error) {
        console.log('No saved state found or error loading state:', error.message);
    }
}

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/user.html');
});

app.get('/main', (req, res) => {
    res.sendFile(__dirname + '/public/main.html');
});

app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

app.get('/history', (req, res) => {
    res.json(buzzerPresses);
});

app.post('/register', (req, res) => {
    const { teamName, socketId } = req.body;

    const team = getTeamByName(teamName);

    if (team) {
        res.status(400).json({ error: 'Team name already registered' });
    } else {
        const pin = crypto.randomBytes(4).toString('hex');
        registeredUsers.set(pin, { teamName, socketId, approved: false });
        res.json({ success: true, pin });
        io.emit('updateUsers', Array.from(registeredUsers.entries()));
        saveState();
    }
});

app.post('/reRegister', (req, res) => {
    const { pin, socketId } = req.body;
    const team = registeredUsers.get(pin);
    if (team && team.approved) {
        team.socketId = socketId;
        const hasPressed = buzzerPresses.some(press => press.teamName === team.teamName);
        res.json({ success: true, hasPressed, teamName: team.teamName, description: team.description });
    } else {
        res.status(401).json({ error: 'Invalid team name or PIN, or registration not approved' });
    }
});

app.post('/changeTeamName', (req, res) => {
    const { oldName, newName, pin } = req.body;
    const team = registeredUsers.get(pin);

    if (team && team.teamName === oldName) {
        if (getTeamByName(newName)) {
            res.status(400).json({ error: 'New team name already exists' });
        } else {
            team.pendingNameChange = newName;
            res.json({ success: true, message: 'Name change request submitted for approval' });
        }
    } else {
        res.status(401).json({ error: 'Invalid team name or PIN' });
    }
});

app.post('/admin/login', checkAuth, (req, res) => {
    const { password } = req.body;
    if (bcrypt.compareSync(password, bcrypt.hashSync(adminPassword, 10))) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

app.get('/admin/users', checkAuth, (req, res) => {
    res.json(Array.from(registeredUsers.entries()));
});

app.post('/admin/approve', checkAuth, (req, res) => {
    const { teamName, approve } = req.body;
    const team = getTeamByName(teamName);
    if (team) {
        team.approved = approve;
        res.json({ success: true });
        io.emit('updateUsers', Array.from(registeredUsers.entries()));

        if (approve && team.socketId) {
            io.to(team.socketId).emit('registrationApproved', team);
        }
        saveState();
    } else {
        res.status(404).json({ error: 'Team not found' });
    }
});

app.post('/admin/approveNameChange', (req, res) => {
    const { oldName, newName, approve } = req.body;
    const team = getTeamByName(oldName);
    if (team && team.pendingNameChange === newName) {
        if (approve) {
            team.teamName = newName;
            io.to(team.socketId).emit('nameChange', { oldName, newName });
        }
        delete team.pendingNameChange;
        res.json({ success: true });
        io.emit('updateUsers', Array.from(registeredUsers.entries()));
    } else {
        res.status(404).json({ error: 'Team or name change request not found' });
    }
});

app.post('/admin/editUser', checkAuth, (req, res) => {
    const { oldName, newName, description } = req.body;
    const team = getTeamByName(oldName);
    if (team) {
        if (getTeamByName(newName) && newName !== oldName) {
            res.status(400).json({ error: 'New team name already exists' });
        } else {
            team.teamName = newName;
            team.description = description;
            delete team.pendingNameChange;
            io.to(team.socketId).emit('teamUpdated', team);
            io.emit('updateUsers', Array.from(registeredUsers.entries()));
            res.json({ success: true });
            saveState();
        }
    } else {
        res.status(404).json({ error: 'Team not found' });
    }
});

app.post('/admin/removeUser', checkAuth, (req, res) => {
    const { teamName } = req.body;
    const pin = Array.from(registeredUsers.entries()).find(([k,v]) => v.teamName === teamName)[0];

    if (pin) {
        const team = registeredUsers.get(pin);
        registeredUsers.delete(pin);
        if (team.socketId) {
            io.to(team.socketId).emit('registrationRemoved', team);
        }
        io.emit('updateUsers', Array.from(registeredUsers.entries()));
        res.json({ success: true });
        saveState();
    } else {
        res.status(404).json({ error: 'Team not found' });
    }
});

app.post('/admin/reset', checkAuth, (req, res) => {
    buzzerPressed = false;
    buzzerPresses.length = 0;
    io.emit('reset');
    res.json({ success: true });
    saveState();
});

io.on('connection', (socket) => {
    socket.on('buzzerPress', (data) => {
        const { pin } = data;
        const team = registeredUsers.get(pin);

        if (team && team.socketId === socket.id) {
            const { teamName, description } = team;
            const timestamp = new Date().toISOString();
            buzzerPresses.push({ teamName, timestamp });
            if (!buzzerPressed) {
                buzzerPressed = true;
                io.emit('buzzerPressed', { teamName, description, timestamp });
            }
            io.emit('updatePresses', buzzerPresses);
            saveState();
        }
    });

    socket.on('disconnect', () => {
        for (const [pin, team] of registeredUsers.entries()) {
            if (team.socketId === socket.id) {
                if (!team.approved) {
                    registeredUsers.delete(pin);
                }
                team.socketId = null;
                break;
            }
        }
        saveState();
        io.emit('updateUsers', Array.from(registeredUsers.entries()));
    });
});

const port = process.env.PORT || 3000;
http.listen(port, () => {
    console.log(`Server running on port ${port}`);
    loadState();
});
