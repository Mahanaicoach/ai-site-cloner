import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const S="/tmp/claude-1000/-home-mahan-GitHub-Custom-Skills/dff31326-4f6e-4f2f-a117-03ae7f26903f/scratchpad";
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900}});
// intercept what gets drawn
await p.addInitScript(()=>{
  window.__calls=[];
  const C=CanvasRenderingContext2D.prototype;
  for(const m of ["drawImage","fillRect","arc","fillText","beginPath","createLinearGradient","createRadialGradient","putImageData","clearRect","rotate","translate","scale"]){
    const o=C[m];
    C[m]=function(...a){ if(window.__calls.length<600) window.__calls.push(m); return o.apply(this,a); };
  }
  const gc=HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext=function(t,...r){ window.__ctxType=(window.__ctxType||[]).concat(t); return gc.call(this,t,...r); };
});
await p.goto("https://uploadthing.com",{waitUntil:"load",timeout:40000});
await p.waitForTimeout(4000);
const info=await p.evaluate(()=>{
  const counts={}; for(const c of window.__calls||[]) counts[c]=(counts[c]||0)+1;
  return {ctxTypes:window.__ctxType, callCounts:counts, total:(window.__calls||[]).length};
});
console.log(JSON.stringify(info,null,1));
// screenshot just the canvas
const c=p.locator("canvas").first();
await c.screenshot({path:S+"/ut-canvas.png"});
console.log("canvas shot saved");
await b.close();
