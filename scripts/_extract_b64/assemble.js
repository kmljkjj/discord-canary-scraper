const fs=require('fs');const path=require('path');
const dir=__dirname;
const parts=[0,1,2].map(i=>fs.readFileSync(path.join(dir,i+'.txt'),'utf8'));
const buf=Buffer.from(parts.join(''),'base64');
const out=path.join(dir,'..','..','src','lib','extract.js');
fs.writeFileSync(out,buf);
console.log('OK',out,buf.length);
if(buf.length<20000) process.exit(1);
