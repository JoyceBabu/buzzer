const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const crypto = require("crypto");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");

const publicDir = path.join(__dirname, "public");

app.use(express.json());
app.use(express.static(publicDir));

const registeredUsers = new Map();
const buzzerPresses = [];
let buzzerPressed = false;
// Without ADMIN_PASSWORD, generate a one-off password and print it at startup.
const adminPassword =
  process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString("base64url");
const stateFilePath = path.join(__dirname, "appState.json");
const ADMIN_ROOM = "admins";

function getTeamByName(teamName) {
  return Array.from(registeredUsers.values()).find(
    (team) => team.teamName === teamName
  );
}

function isValidAuthHeader(authHeader) {
  if (typeof authHeader !== "string") {
    return false;
  }

  const encodedCredentials = authHeader.split(" ")[1] || "";
  // btoa() on the client produces Latin-1, so decode the same way.
  const decodedCredentials = Buffer.from(encodedCredentials, "base64").toString(
    "latin1"
  );
  // Split on the first colon only; passwords may contain colons.
  const separatorIndex = decodedCredentials.indexOf(":");
  if (separatorIndex === -1) {
    return false;
  }
  const username = decodedCredentials.slice(0, separatorIndex);
  const password = decodedCredentials.slice(separatorIndex + 1);

  return username === "admin" && safeEqual(password, adminPassword);
}

// Constant-time string comparison. Hashing first gives both buffers the
// same length, which timingSafeEqual requires.
function safeEqual(a, b) {
  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function checkAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "No credentials sent!" });
  }

  if (isValidAuthHeader(authHeader)) {
    next(); // Proceed to the next middleware or route handler
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
}

// Team list for the admin screen. PINs and socket IDs never leave the server.
function usersForAdmin() {
  return Array.from(registeredUsers.values()).map(
    ({ teamName, approved, description, pendingNameChange }) => ({
      teamName,
      approved,
      description,
      pendingNameChange,
    })
  );
}

function broadcastUsers() {
  io.to(ADMIN_ROOM).emit("updateUsers", usersForAdmin());
}

let saveInProgress = null;
let saveQueued = false;

// Writes run one at a time; calls made during a write are coalesced into a
// single follow-up write that snapshots the latest state.
function saveState() {
  if (saveInProgress) {
    saveQueued = true;
    return saveInProgress;
  }
  saveInProgress = writeState()
    .catch((error) => console.error("Error saving state:", error.message))
    .finally(() => {
      saveInProgress = null;
      if (saveQueued) {
        saveQueued = false;
        saveState();
      }
    });
  return saveInProgress;
}

// Write to a temp file and rename it, so a crash mid-write can't leave a
// truncated appState.json behind.
async function writeState() {
  const state = {
    registeredUsers: Array.from(registeredUsers.entries()),
    buzzerPresses,
    buzzerPressed,
  };
  const tempFilePath = `${stateFilePath}.tmp`;
  await fs.writeFile(tempFilePath, JSON.stringify(state, null, 2));
  await fs.rename(tempFilePath, stateFilePath);
}

async function loadState() {
  try {
    const data = await fs.readFile(stateFilePath, "utf8");
    const state = JSON.parse(data);
    state.registeredUsers.forEach(([key, value]) =>
      registeredUsers.set(key, value)
    );
    buzzerPresses.push(...state.buzzerPresses);
    buzzerPressed = state.buzzerPressed;
    console.log("State loaded successfully");
  } catch (error) {
    console.log("No saved state found or error loading state:", error.message);
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "user.html"));
});

app.get("/main", (req, res) => {
  res.sendFile(path.join(publicDir, "main.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/history", (req, res) => {
  res.json(buzzerPresses);
});

app.post("/register", (req, res) => {
  const { teamName, socketId } = req.body ?? {};

  const team = getTeamByName(teamName);

  if (team) {
    res.status(400).json({ error: "Team name already registered" });
  } else {
    const pin = crypto.randomBytes(4).toString("hex");
    registeredUsers.set(pin, { teamName, socketId, approved: false });
    res.json({ success: true, pin });
    broadcastUsers();
    saveState();
  }
});

app.post("/reRegister", (req, res) => {
  const { pin, socketId } = req.body ?? {};
  const team = registeredUsers.get(pin);
  if (team && team.approved) {
    team.socketId = socketId;
    const hasPressed = buzzerPresses.some(
      (press) => press.teamName === team.teamName
    );
    res.json({
      success: true,
      hasPressed,
      teamName: team.teamName,
      description: team.description,
    });
  } else {
    res
      .status(401)
      .json({
        error: "Invalid team name or PIN, or registration not approved",
      });
  }
});

app.post("/changeTeamName", (req, res) => {
  const { oldName, newName, pin } = req.body ?? {};
  const team = registeredUsers.get(pin);

  if (team && team.teamName === oldName) {
    if (getTeamByName(newName)) {
      res.status(400).json({ error: "New team name already exists" });
    } else {
      team.pendingNameChange = newName;
      broadcastUsers();
      saveState();
      res.json({
        success: true,
        message: "Name change request submitted for approval",
      });
    }
  } else {
    res.status(401).json({ error: "Invalid team name or PIN" });
  }
});

// checkAuth has already validated the credentials.
app.post("/admin/login", checkAuth, (req, res) => {
  res.json({ success: true });
});

app.get("/admin/users", checkAuth, (req, res) => {
  res.json(usersForAdmin());
});

app.post("/admin/approve", checkAuth, (req, res) => {
  const { teamName, approve } = req.body ?? {};
  const team = getTeamByName(teamName);
  if (team) {
    team.approved = approve;
    res.json({ success: true });
    broadcastUsers();

    if (approve && team.socketId) {
      io.to(team.socketId).emit("registrationApproved", team);
    }
    saveState();
  } else {
    res.status(404).json({ error: "Team not found" });
  }
});

app.post("/admin/approveNameChange", checkAuth, (req, res) => {
  const { oldName, newName, approve } = req.body ?? {};
  const team = getTeamByName(oldName);
  if (team && team.pendingNameChange === newName) {
    if (approve) {
      team.teamName = newName;
      io.to(team.socketId).emit("nameChange", { oldName, newName });
    }
    delete team.pendingNameChange;
    res.json({ success: true });
    broadcastUsers();
    saveState();
  } else {
    res.status(404).json({ error: "Team or name change request not found" });
  }
});

app.post("/admin/editUser", checkAuth, (req, res) => {
  const { oldName, newName, description } = req.body ?? {};
  const team = getTeamByName(oldName);
  if (team) {
    if (getTeamByName(newName) && newName !== oldName) {
      res.status(400).json({ error: "New team name already exists" });
    } else {
      team.teamName = newName;
      team.description = description;
      delete team.pendingNameChange;
      io.to(team.socketId).emit("teamUpdated", team);
      broadcastUsers();
      res.json({ success: true });
      saveState();
    }
  } else {
    res.status(404).json({ error: "Team not found" });
  }
});

app.post("/admin/removeUser", checkAuth, (req, res) => {
  const { teamName } = req.body ?? {};
  const pin = Array.from(registeredUsers.entries()).find(
    ([k, v]) => v.teamName === teamName
  )?.[0];

  if (pin) {
    const team = registeredUsers.get(pin);
    registeredUsers.delete(pin);
    if (team.socketId) {
      io.to(team.socketId).emit("registrationRemoved", team);
    }
    broadcastUsers();
    res.json({ success: true });
    saveState();
  } else {
    res.status(404).json({ error: "Team not found" });
  }
});

app.post("/admin/reset", checkAuth, (req, res) => {
  buzzerPressed = false;
  buzzerPresses.length = 0;
  io.emit("reset");
  res.json({ success: true });
  saveState();
});

io.on("connection", (socket) => {
  socket.on("adminAuth", (authHeader) => {
    if (isValidAuthHeader(authHeader)) {
      socket.join(ADMIN_ROOM);
      socket.emit("updateUsers", usersForAdmin());
    }
  });

  socket.on("buzzerPress", (data) => {
    const { pin } = data ?? {};
    const team = registeredUsers.get(pin);

    // Only approved teams may buzz, and only once per round.
    if (
      team &&
      team.approved &&
      team.socketId === socket.id &&
      !buzzerPresses.some((press) => press.teamName === team.teamName)
    ) {
      const { teamName, description } = team;
      const timestamp = new Date().toISOString();
      buzzerPresses.push({ teamName, timestamp });
      if (!buzzerPressed) {
        buzzerPressed = true;
        io.emit("buzzerPressed", { teamName, description, timestamp });
      }
      io.emit("updatePresses", buzzerPresses);
      saveState();
    }
  });

  // Main screen and admin sockets aren't teams, so only act when a team's
  // socket disconnects.
  socket.on("disconnect", () => {
    for (const [pin, team] of registeredUsers.entries()) {
      if (team.socketId === socket.id) {
        if (!team.approved) {
          registeredUsers.delete(pin);
        }
        team.socketId = null;
        saveState();
        broadcastUsers();
        break;
      }
    }
  });
});

const port = process.env.PORT || 3000;

const roles = [
  { label: "User", path: "/" },
  { label: "Main", path: "/main" },
  { label: "Admin", path: "/admin" },
];

// IPv4 only: IPv6 link-local addresses need a zone ID that phone browsers
// won't accept.
function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface.family === "IPv4" && !iface.internal)
    .map((iface) => iface.address);
}

function logRoleUrls() {
  const hosts = ["localhost", ...getLanAddresses()];
  const labelWidth = Math.max(...roles.map(({ label }) => label.length)) + 3;
  for (const { label, path: rolePath } of roles) {
    hosts.forEach((host, index) => {
      const prefix = index === 0 ? `${label}:` : "";
      console.log(`${prefix.padEnd(labelWidth)}http://${host}:${port}${rolePath}`);
    });
  }
}

// Load saved state first so early clients don't see an empty game.
loadState().then(() => {
  http.listen(port, () => {
    console.log(`Server running on port ${port}\n`);
    logRoleUrls();
    if (!process.env.ADMIN_PASSWORD) {
      console.log(`Admin password (set ADMIN_PASSWORD to choose one): ${adminPassword}`);
    }
  });
});
