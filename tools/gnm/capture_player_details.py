"""Capture age/skin-tone and orbit/grooming evidence with fixed grooming pigments."""
import argparse,base64,json
from pathlib import Path
from playwright.sync_api import sync_playwright
SCRIPT='''async () => {
 const model=await import('./src/face-model.js');
 const renderer=await import('./src/gnm-player-renderer.js');
 const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;document.body.append(canvas);
 const tiles=[], diagnostics=[];
 async function tile(skin,age,hair,beard,yaw,label){
  let p=model.createProfile({seed:'detail-player-42',age,presentation:'masculine'});
  for(const [key,value] of Object.entries({skin,hairVisible:hair<0?0:1,hair:Math.max(hair,0),beard,brows:3,hairColor:0,glasses:0,freckles:0,scar:0}))p=model.setFeature(p,key,value);
  const result=await renderer.renderGnmPlayerFace(canvas,p,{expressionMode:'neutral',diagnosticGroomingAge:30,camera:{yaw,pitch:-0.06,distance:.87}});
  tiles.push({image:canvas.toDataURL(),label});diagnostics.push({label,age,skin,fixedGroomingAge:30,identity:result.diagnostics.identityCoefficientsHead,wrinkleStrength:result.diagnostics.wrinkleStrength,groomingStrands:result.diagnostics.groomingStrands,collar:result.diagnostics.collar});
 }
 for(const skin of [0,4,7]) for(const age of [22,40,60])await tile(skin,age,-1,0,.15,`Skin ${skin} / Age ${age}`);
 for(const yaw of [0,.5,1.45])await tile(3,45,4,3,yaw,`Medium hair + full beard / yaw ${yaw}`);
 for(const yaw of [0,.5,1.45])await tile(1,32,6,1,yaw,`Curly + stubble / yaw ${yaw}`);
 const sheet=document.createElement('canvas');sheet.width=1536;sheet.height=tiles.length/3*542;const ctx=sheet.getContext('2d');
 ctx.fillStyle='#17212c';ctx.fillRect(0,0,sheet.width,sheet.height);
 for(let i=0;i<tiles.length;i++){const im=new Image();im.src=tiles[i].image;await im.decode();ctx.drawImage(im,(i%3)*512,Math.floor(i/3)*542);ctx.fillStyle='white';ctx.font='18px sans-serif';ctx.fillText(tiles[i].label,(i%3)*512+12,Math.floor(i/3)*542+534);}
 return {image:sheet.toDataURL(),diagnostics};
}'''
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir',type=Path,default=Path('docs/gnm-3d-player/details'))
args=parser.parse_args()
args.output_dir.mkdir(parents=True,exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--enable-unsafe-swiftshader'])
 page=b.new_page();page.goto('http://localhost:8080/index.module.html');page.wait_for_load_state('networkidle');r=page.evaluate(SCRIPT);b.close()
 (args.output_dir/'details.png').write_bytes(base64.b64decode(r['image'].split(',')[1]));(args.output_dir/'details.json').write_text(json.dumps(r['diagnostics'],indent=2))

for skin in (0,4,7):
 ages=[d for d in r['diagnostics'][:9] if d['skin']==skin]
 assert ages[0]['identity']==ages[1]['identity']==ages[2]['identity']
 assert [d['wrinkleStrength'] for d in ages]==[0,0.375,1]
print(f"PASS 15 age/skin/orbit/grooming cases -> {args.output_dir}")
