const fs = require('fs');
const path = require('path');
const parts = ['scrape.part0.js', 'scrape.part1.js', 'scrape.part2.js'];
let code = '';
for (const p of parts) {
  code += fs.readFileSync(path.join(__dirname, p), 'utf8');
}
const Module = require('module');
const m = new Module(path.join(__dirname, 'scrape.js'));
m.filename = path.join(__dirname, 'scrape.js');
m.paths = Module._nodeModulePaths(__dirname);
m._compile(code, m.filename);
