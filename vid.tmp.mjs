import { chromium } from "playwright";
const S="/tmp/claude-1000/-home-mahan-GitHub-Custom-Skills/dff31326-4f6e-4f2f-a117-03ae7f26903f/scratchpad/vid";
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:700,height:700},recordVideo:{dir:S,size:{width:700,height:700}}});
const p=await ctx.newPage();
await p.goto("https://uploadthing.com",{waitUntil:"load",timeout:40000});
await p.waitForTimeout(3000);
// isolate: pin the canvas to fill the viewport, hide everything else
await p.evaluate(()=>{
  const c=document.querySelector("canvas");
  document.body.style.cssText="margin:0;padding:0;overflow:hidden;background:#0a0004";
  document.documentElement.style.background="#0a0004";
  for(const el of document.body.querySelectorAll("*")) if(!el.contains(c)&&el!==c) el.style.visibility="hidden";
  c.style.cssText="position:fixed;top:0;left:0;width:700px;height:700px;visibility:visible;z-index:99999";
});
await p.waitForTimeout(5000); // record 5s of motion
await ctx.close(); await b.close();
console.log("recorded");
