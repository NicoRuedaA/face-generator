"""Capture the side-part trial with the same identity, lighting and camera."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', type=Path, default=Path('docs/gnm-3d-player/hairstyle-prototype'))
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width': 1536, 'height': 1100}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://localhost:8080/index.module.html')
    page.wait_for_load_state('networkidle')
    result = page.evaluate('''async () => {
      const model = await import('./src/face-model.js');
      const renderer = await import('./src/gnm-player-renderer.js');
      const canvas = document.createElement('canvas'); canvas.width=512; canvas.height=512;
      document.body.append(canvas);
      const tiles=[], diagnostics=[];
      for (const shape of ['baseline', 'narrow', 'broad']) {
        let profile=model.createProfile({seed:'detail-player-42',age:30,presentation:'masculine'});
        const traits={hairVisible:1,hair:4,hairColor:2,beard:0,glasses:0,freckles:0,scar:0};
        if(shape==='narrow') Object.assign(traits,{head:2,jaw:0,faceProportion:4});
        if(shape==='broad') Object.assign(traits,{head:1,jaw:4,faceProportion:0});
        for(const [key,value] of Object.entries(traits))profile=model.setFeature(profile,key,value);
        for(const hairstylePrototype of ['original','side-part']) {
          for(const yaw of [0,-1.45,1.45]) {
            const r=await renderer.renderGnmPlayerFace(canvas,profile,{hairstylePrototype,expressionMode:'neutral',camera:{yaw,pitch:-.06,distance:1.08}});
            const label=`${shape} / ${hairstylePrototype} / yaw ${yaw}`;
            tiles.push({label,image:canvas.toDataURL(),shape});
            diagnostics.push({label,code:model.formatFaceCode(profile),...r.diagnostics});
          }
        }
      }
      canvas.remove();
      document.body.replaceChildren(); document.body.style='margin:0;background:#17212c;color:white;font:18px sans-serif';
      const sheet=document.createElement('div');sheet.id='comparison';sheet.style='display:grid;grid-template-columns:repeat(3,512px);width:1536px';
      for(const tile of tiles) {
        const box=document.createElement('div');box.dataset.shape=tile.shape;
        const img=document.createElement('img');img.src=tile.image;img.style='display:block;width:512px;height:512px';
        const label=document.createElement('div');label.textContent=tile.label;label.style='height:30px;padding-left:12px';
        box.append(img,label);sheet.append(box);
      }
      document.body.append(sheet); await Promise.all([...sheet.querySelectorAll('img')].map(img=>img.decode()));
      return diagnostics;
    }''')
    for shape in ('baseline', 'narrow', 'broad'):
        page.evaluate('(shape) => document.querySelectorAll("[data-shape]").forEach(el => el.hidden=el.dataset.shape!==shape)', shape)
        page.locator('#comparison').screenshot(path=str(args.output_dir / f'{shape}.png'))
    (args.output_dir / 'diagnostics.json').write_text(json.dumps(result, indent=2)+'\n')
    for offset in (0,6,12):
        group=result[offset:offset+6]
        assert len({d['code'] for d in group}) == 1
        assert all(d['identityCoefficientsHead']==group[0]['identityCoefficientsHead'] for d in group)
        assert all(d['framebufferStatus']=='complete' for d in group)
    assert not errors, errors
    browser.close()
print('PASS 18 same-face comparisons: front / left / right; baseline / narrow / broad')
