import { chromium } from "playwright";
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1440,height:900}});
await p.goto("https://uploadthing.com",{waitUntil:"load",timeout:40000});
await p.waitForTimeout(3000);
console.log(await p.evaluate(()=>{
  const cs=[...document.querySelectorAll("canvas")];
  return JSON.stringify(cs.map(c=>{
    const r=c.getBoundingClientRect(), st=getComputedStyle(c);
    return {w:c.width,h:c.height,cssW:Math.round(r.width),cssH:Math.round(r.height),
      x:Math.round(r.x),y:Math.round(r.y),cls:c.className,id:c.id,
      pos:st.position,z:st.zIndex,opacity:st.opacity,
      parentCls:(c.parentElement?.className||"").toString().slice(0,90),
      parentTag:c.parentElement?.tagName,
      ancestors:[...(function*(e){let n=e.parentElement;let i=0;while(n&&i++<4){yield n.tagName+"."+(n.className||"").toString().split(" ")[0];n=n.parentElement}})(c)]};
  }),null,1);
}));
await b.close();
