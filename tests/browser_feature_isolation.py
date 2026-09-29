"""Native browser evidence for feature isolation and real-render style catalogs."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--entrypoint', choices=['index.html', 'index.module.html'], default='index.module.html')
parser.add_argument('--check-only', action='store_true', help='Run all assertions without duplicating screenshot artifacts')
args = parser.parse_args()
OUT = Path('docs/gnm-3d-player/feature-isolation')
OUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--enable-unsafe-swiftshader'])
    page = browser.new_page(viewport={'width':1440,'height':1100}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(f'http://localhost:8080/{args.entrypoint}')
    page.wait_for_load_state('networkidle')
    page.wait_for_function("document.querySelector('#portrait-gnm3d').__sportsFaceWebglDiagnostics", timeout=60000)
    code = page.evaluate("""async () => {
      const m=await import('./src/face-model.js');
      let profile=m.createProfile({seed:777,age:24,presentation:'neutral'});
      for(const [key,value] of Object.entries({skin:2,hairColor:2,hair:0,hairVisible:1,beard:0,brows:0,freckles:0,scar:0,glasses:0,eyeColor:0,eyes:0,mouth:0,nose:0,earShape:0}))profile=m.setFeature(profile,key,value);
      window.capturePixels = () => {
        const c=document.querySelector('#portrait-gnm3d'), gl=c.getContext('webgl2');
        const data=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);
        gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,data);
        return data;
      };
      return m.formatFaceCode(profile);
    }""")
    page.locator('#face-code').fill(code)
    page.locator('#load-code').click()
    page.wait_for_timeout(1500)
    page.locator('#reset-webgl-camera').click()
    results=[]
    tiles=[]
    for expression in ['neutral','auto']:
        page.locator('#expression-mode').select_option(expression)
        page.wait_for_timeout(700)
        page.evaluate('window.referencePixels = window.capturePixels()')
        baseline=page.evaluate("document.querySelector('#portrait-gnm3d').__sportsFaceWebglDiagnostics")
        if not args.check_only:
            page.locator('#portrait-gnm3d').screenshot(path=str(OUT/f'{expression}-baseline.png'))
        tiles.append((expression,'baseline',page.locator('#portrait-gnm3d').evaluate('(c)=>c.toDataURL()')))
        for key,value in [('brows',7),('freckles',1),('eyeColor',2),('eyes',3),('mouth',3),('earShape',3),('nose',1)]:
            page.locator(f'select[data-feature={key}]').select_option(str(value))
            page.wait_for_timeout(450)
            diagnostic=page.evaluate("document.querySelector('#portrait-gnm3d').__sportsFaceWebglDiagnostics")
            assert diagnostic['identityCoefficientsHead']==baseline['identityCoefficientsHead'],key
            assert diagnostic['expression']==baseline['expression'],key
            diff=page.evaluate("""() => {
              const now=window.capturePixels(), old=window.referencePixels;
              let changed=0,max=0;const w=document.querySelector('#portrait-gnm3d').width,h=document.querySelector('#portrait-gnm3d').height;
              let minX=w,minY=h,maxX=0,maxY=0;
              for(let i=0;i<now.length;i+=4) {
                const d=Math.max(...[0,1,2].map(a=>Math.abs(now[i+a]-old[i+a])));
                if(d>1) {changed++;const x=(i/4)%w,y=h-1-Math.floor(i/4/w);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
                max=Math.max(max,d);
              }
              return {changed,total:now.length/4,fraction:changed/(now.length/4),max,bounds:[minX,minY,maxX,maxY]};
            }""")
            assert diff['changed']>10,(expression,key,diff)
            assert diff['fraction']<.18,(expression,key,diff)
            results.append({'expression':expression,'feature':key,'value':value,'pixels':diff})
            if not args.check_only:
                page.locator('#portrait-gnm3d').screenshot(path=str(OUT/f'{expression}-{key}.png'))
            tiles.append((expression,key,page.locator('#portrait-gnm3d').evaluate('(c)=>c.toDataURL()')))
            page.locator(f'select[data-feature={key}]').select_option('0')
            page.wait_for_timeout(350)
            assert page.evaluate('window.capturePixels().every((v,i)=>v===window.referencePixels[i])'),f'{key}: exact visual round-trip'
    for key,count in [('hair',12),('beard',6),('brows',8)]:
        page.locator(f'[data-catalog={key}] summary').click()
        page.wait_for_function('(count)=>document.querySelectorAll(".style-card canvas[data-ready]").length>=count',arg=sum(n for k,n in [('hair',12),('beard',6),('brows',8)][:['hair','beard','brows'].index(key)+1]),timeout=60000)
        cards=page.locator(f'button[data-style-feature={key}]')
        assert cards.count()==count
        # Keyboard activates the same actual renderer control, including automatic hair visibility.
        page.locator('select[data-feature=hairVisible]').select_option('0')
        page.wait_for_timeout(400)
        cards.nth(count-1).press('Enter');page.wait_for_timeout(650)
        assert page.locator(f'select[data-feature={key}]').input_value()==str(count-1), (key,page.locator(f'select[data-feature={key}]').input_value(),page.evaluate('document.activeElement.outerHTML'))
        assert cards.nth(count-1).get_attribute('aria-pressed')=='true'
        if key=='hair': assert page.locator('select[data-feature=hairVisible]').input_value()=='1'
        if not args.check_only:
            page.locator(f'[data-catalog={key}]').screenshot(path=str(OUT/f'catalog-{key}.png'))
    if not args.check_only:
        page.locator('#style-catalogs').screenshot(path=str(OUT/'catalog-desktop.png'))
    page.set_viewport_size({'width':390,'height':844})
    page.wait_for_timeout(400)
    assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'), 'mobile horizontal overflow'
    if not args.check_only:
        page.locator('#style-catalogs').screenshot(path=str(OUT/'catalog-mobile.png'))
    page.set_viewport_size({'width':1600,'height':1100})
    page.evaluate("""tiles => {
      document.body.replaceChildren();document.body.style='margin:0;background:#141b24;color:white;font:20px sans-serif';
      const sheet=document.createElement('div');sheet.id='evidence';sheet.style='display:grid;grid-template-columns:repeat(4,400px);width:1600px';
      for(const [expression,key,src] of tiles) {const box=document.createElement('div');const label=document.createElement('div');label.textContent=expression+' / '+key;label.style='padding:8px';const img=document.createElement('img');img.src=src;img.style='width:400px;height:400px;display:block';box.append(label,img);sheet.append(box);}document.body.append(sheet);
    }""",tiles)
    page.wait_for_timeout(300)
    if not args.check_only:
        page.locator('#evidence').screenshot(path=str(OUT/'comparison.png'))
    assert not errors,errors
    (OUT/('browser-bundle-results.json' if args.entrypoint=='index.html' else 'browser-results.json')).write_text(json.dumps({'entrypoint':args.entrypoint,'results':results,'catalogs':{'hair':12,'beard':6,'brows':8},'mobileWidth':390,'errors':errors},indent=2)+'\n')
    browser.close()
print(f'PASS {args.entrypoint}: 14 real UI edits, neutral/automatic, exact pixel restoration, 26 real thumbnails, keyboard, 390px mobile, no browser errors')
