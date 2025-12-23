module.exports = {
  apps: [
    {
      name: "imessage-next-dev",
      script: "bun",
      args: "run next:dev",
      env: {
        NODE_ENV: "development",
      },
    },
    {
      name: "imessage-electron-dev",
      script: "bun",
      args: "run electron:dev",
      env: {
        NODE_ENV: "development",
      },
    },
  ],
};
