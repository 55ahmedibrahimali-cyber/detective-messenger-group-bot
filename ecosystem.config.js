module.exports = {
  apps: [
    {
      name: "detective-bot",
      script: "server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "600M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 100,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
