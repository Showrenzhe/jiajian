'use strict';

const { app } = require('electron');
const { launchDesktop } = require('./desktop.cjs');

launchDesktop().catch((error) => {
  console.error(error);
  app.exit(1);
});
