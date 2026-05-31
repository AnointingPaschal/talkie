'use strict';
const { contextBridge } = require('electron');
// Expose minimal safe API to renderer
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  version:  process.versions.electron,
});
