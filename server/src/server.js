'use strict';
/* Starts the READYLINK server.   Run from the server/ folder:  npm start   (or: npm run dev) */
const { prepare } = require('./bootstrap');

const { config, geo, db, loadedEnv } = prepare();

const { createApp } = require('./app');
const app = createApp(config, { db, geo });

const server = app.listen(config.port, config.host, () => {
  const { port } = server.address();
  console.log('\nREADYLINK server is running.');
  console.log(`  App:      http://localhost:${port}/`);
  console.log(`  Health:   http://localhost:${port}/api/health`);
  console.log(`  Reports:  http://localhost:${port}/api/reports`);
  console.log(`  Database: ${config.dbFile} (${db.driver})`);
  console.log(`  Mode:     ${config.nodeEnv}${loadedEnv ? ' (settings loaded from server/.env)' : ' (no server/.env found, using defaults)'}`);
  console.log(`  Admin:    ${config.adminAuth.configured ? `login set up for "${config.adminAuth.username}"` : 'NOT SET UP. Nobody can sign in or change reports. Run:  npm.cmd run admin:setup'}`);
  console.log(`  Changes:  ${config.adminWrites ? 'allowed for a signed-in admin' : 'turned OFF (set ADMIN_WRITES=on to allow them)'}`);
  console.log(`  Search:   place search ${config.geocoder.provider === 'off' ? 'turned off' : `uses ${config.geocoder.provider} through this server (needs internet)`}`);
  if (config.adminAuth.configured && !config.isProduction && !config.isLoopbackOnly) {
    console.warn('\n  WARNING: the admin login travels over plain HTTP on your network. Use HTTPS before using this outside your own computer.');
  }
  if (!config.isLoopbackOnly) {
    console.warn(`\n  WARNING: HOST=${config.host} makes the server reachable from other devices on your network.`);
    console.warn('  Use 127.0.0.1 unless you really want that.');
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\nPort ${config.port} is already in use. Stop the other program or change PORT in server/.env.\n`);
  else if (err.code === 'EACCES') console.error(`\nNo permission to use port ${config.port}. Try a port above 1024 (for example 3000).\n`);
  else console.error('\nServer error:', err.message, '\n');
  process.exit(1);
});

function shutdown() {
  console.log('\nStopping READYLINK server...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
  if (server.closeAllConnections) server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
