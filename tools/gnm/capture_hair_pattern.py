"""Native hair closeups: fixed face, four styles, dark/blond/gray, two angles."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--phase', choices=['before', 'after'], required=True)
parser.add_argument('--base-url', default='http://localhost:8080')
parser.add_argument('--output-dir', type=Path, default=Path('docs/gnm-3d-player/hair-pattern-fix'))
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width': 1536, 'height': 1250}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'{args.base_url}/index.module.html')
    page.wait_for_load_state('networkidle')
    result = page.evaluate('''async () => {
      const model=await import('./src/face-model.js');
      const renderer=await import('./src/gnm-player-renderer.js');
      const canvas=document.createElement('canvas');canvas.width=768;canvas.height=768;document.body.append(canvas);
      const tiles=[], diagnostics=[];
      for(const [style,hair,hairstylePrototype] of [['short',0,'original'],['medium',4,'original'],['curly',6,'original'],['side-part',4,'side-part']]) {
        for(const [angle,yaw] of [['front',0.15],['side',1.2]]) {
          for(const hairColor of [0,4,7]) {
            let profile=model.createProfile({seed:'detail-player-42',age:30,presentation:'masculine'});
            for(const [key,value] of Object.entries({hairVisible:1,hair,hairColor,beard:0,glasses:0,freckles:0,scar:0}))profile=model.setFeature(profile,key,value);
            const r=await renderer.renderGnmPlayerFace(canvas,profile,{hairstylePrototype,expressionMode:'neutral',camera:{yaw,pitch:-.12,distance:1.08}});
            const label=`${style} / ${['dark','','','','blond','','','gray'][hairColor]} / ${angle}`;
            tiles.push({label,image:canvas.toDataURL(),angle});
            diagnostics.push({label,code:model.formatFaceCode(profile),...r.diagnostics});
          }
        }
      }
      canvas.remove();document.body.replaceChildren();document.body.style='margin:0;background:#17212c;color:white;font:18px sans-serif';
      const sheet=document.createElement('div');sheet.id='comparison';sheet.style='display:grid;grid-template-columns:repeat(3,512px);width:1536px';
      for(const tile of tiles) {
        const box=document.createElement('div');box.dataset.angle=tile.angle;
        const crop=document.createElement('div');crop.style='height:280px;width:512px;overflow:hidden';
        const img=document.createElement('img');img.src=tile.image;img.style='display:block;width:768px;height:768px;max-width:none;margin-left:-128px;margin-top:-35px';crop.append(img);
        const label=document.createElement('div');label.textContent=tile.label;label.style='height:24px;padding-left:12px';box.append(crop,label);sheet.append(box);
      }
      document.body.append(sheet);await Promise.all([...sheet.querySelectorAll('img')].map(img=>img.decode()));return diagnostics;
    }''')
    for angle in ('front', 'side'):
        page.evaluate('(angle) => document.querySelectorAll("[data-angle]").forEach(el=>el.hidden=el.dataset.angle!==angle)', angle)
        page.locator('#comparison').screenshot(path=str(args.output_dir / f'{args.phase}-{angle}.png'))
    (args.output_dir / f'{args.phase}.json').write_text(json.dumps(result, indent=2)+'\n')
    assert len(result) == 24
    assert all(d['framebufferStatus'] == 'complete' for d in result)
    assert all(d['identityCoefficientsHead'] == result[0]['identityCoefficientsHead'] for d in result)
    assert not errors, errors
    browser.close()
print(f'PASS 24 {args.phase} hair closeups: four styles, three colors, two angles')
