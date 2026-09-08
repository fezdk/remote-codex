import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir:'./test/browser',
  fullyParallel:false,
  workers:1,
  use:{baseURL:'http://127.0.0.1:4311',viewport:{width:1440,height:1000},trace:'retain-on-failure'},
  webServer:{command:'node test/fixture-server.js',url:'http://127.0.0.1:4311',reuseExistingServer:false},
});
