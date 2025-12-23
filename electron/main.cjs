const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { fork } = require("node:child_process");

const isDev = !app.isPackaged;
const host = "127.0.0.1";
let serverProcess = null;
let mainWindow = null;
let lastUrl = null;

function createWindow(url) {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    backgroundColor: "#0b0b0b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(url);
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (port) resolve(port);
        else reject(new Error("Unable to allocate port"));
      });
    });
  });
}

function waitForPort(port, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();

    const attempt = () => {
      const socket = net.connect({ port, host });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Timed out waiting for server"));
          return;
        }
        setTimeout(attempt, 200);
      });
    };

    attempt();
  });
}

async function startNextServer() {
  if (isDev) {
    const devUrl = process.env.NEXT_DEV_SERVER_URL || `http://${host}:3000`;
    lastUrl = devUrl;
    return devUrl;
  }

  const port = await findOpenPort();
  const serverPath = path.join(process.resourcesPath, "next", "server.js");
  const cwd = path.dirname(serverPath);

  serverProcess = fork(serverPath, [], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "production",
      HOSTNAME: host,
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      IMESSAGE_SETTINGS_DIR: app.getPath("userData"),
    },
    stdio: "pipe",
  });

  if (serverProcess.stdout) {
    serverProcess.stdout.on("data", (data) => console.log(`[next] ${data}`));
  }
  if (serverProcess.stderr) {
    serverProcess.stderr.on("data", (data) => console.error(`[next] ${data}`));
  }

  serverProcess.on("exit", (code) => {
    console.error(`Next server exited with code ${code}`);
  });

  await waitForPort(port);

  const url = `http://${host}:${port}`;
  lastUrl = url;
  return url;
}

async function bootstrap() {
  try {
    const url = await startNextServer();
    createWindow(url);
  } catch (error) {
    console.error("Failed to start server:", error);
    dialog.showErrorBox("Startup Error", "Unable to start the local server. Check the logs for details.");
    app.quit();
  }
}

app.whenReady().then(bootstrap);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && lastUrl) {
    createWindow(lastUrl);
  }
});

app.on("before-quit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
