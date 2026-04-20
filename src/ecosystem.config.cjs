// PM2 ecosystem file for running the backend as a Windows service.
//   npm run pm2:start
//   npm run pm2:reload
//   npm run pm2:stop
module.exports = {
  apps: [
    {
      name:            'valuecart-mom-server',
      script:          'src/server.js',
      cwd:             __dirname + '/..',
      exec_mode:       'fork',
      instances:       1,
      autorestart:     true,
      max_restarts:    10,
      min_uptime:      '30s',
      watch:           false,
      max_memory_restart: '500M',
      time:            true,
      env: {
        NODE_ENV: 'production',
      },
      out_file:   './logs/out.log',
      error_file: './logs/err.log',
      merge_logs: true,
    },
  ],
}
