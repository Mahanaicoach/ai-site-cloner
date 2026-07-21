import { chromium } from "playwright";
import { createHash } from "node:crypto";
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto("https://uploadthing.com",{waitUntil:"load",timeout:40000});
await p.waitForTimeout(3500);
const c=p.locator("canvas").first();
const hashes=[];
for(let i=0;i<4;i++){
  const buf=await c.screenshot();
  hashes.push(createHash("md5").update(buf).digest("hex").slice(0,12));
  await p.waitForTimeout(1200);
}
console.log("frame hashes:",hashes.join(" "));
console.log("animated:", new Set(hashes).size>1);
await b.close();
