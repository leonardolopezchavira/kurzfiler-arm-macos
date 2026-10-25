import subprocess, time, os, json, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, '.work'); os.makedirs(WORK + '/shots', exist_ok=True)
TMP = os.path.join(WORK, 't.krz')
shutil.copy(os.path.join(os.environ.get('KF_ORIG', os.path.join(WORK, 'kurzfiler')), 'tests', 'TestNewKeymap.krz'), TMP)
from playwright.sync_api import sync_playwright
# Needs a Linux Electron 39 binary (ELECTRON), Xvfb and Playwright
E = os.environ.get('ELECTRON', 'electron')
proc = subprocess.Popen(['xvfb-run', '-a', E, '--no-sandbox', '--remote-debugging-port=9333', os.path.join(os.path.dirname(HERE), 'app'), TMP],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
import urllib.request
for i in range(60):
    try: urllib.request.urlopen('http://127.0.0.1:9333/json/version', timeout=1); break
    except Exception: time.sleep(1)
time.sleep(2)
res = []
try:
    with sync_playwright() as p:
        b = p.chromium.connect_over_cdp('http://127.0.0.1:9333')
        page = b.contexts[0].pages[0]
        errs = []
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        time.sleep(1)
        res.append(('native bridge present', page.evaluate('!!window.kfNative')))
        n0 = page.evaluate('kf.state.objects.size'); print('size', n0); res.append(('file from command line opened', n0 == 5))
        res.append(('path known', page.evaluate('kf.state.path') == TMP))
        # rename then save in place through the native write
        page.evaluate("""(() => { const m = kf.state; const h = kf.K.makeHash(200, 36); kf.state.sel = new Set([h]); })()""")
        page.evaluate("""(() => { const o = kf.state.objects.get(kf.K.makeHash(200,36)).clone(); o.name='Saved Natively'; const n = new Map(kf.state.objects); n.set(o.hash,o); kf.state.undo.push({label:'x',objects:kf.state.objects}); kf.state.objects = n; })()""")
        page.evaluate("void kf.run('save')")
        time.sleep(1.5)
        res.append(('saved in place', b'Saved Natively' in open(TMP, 'rb').read()))
        res.append(('clean after save', page.evaluate('kf.state.objects === kf.state.saved')))
        page.screenshot(path=os.path.join(WORK, 'shots', '20-electron.png'))
        # close request with unsaved change -> our dialog appears
        page.evaluate("""(() => { const n = new Map(kf.state.objects); kf.state.undo.push({label:'x',objects:kf.state.objects}); n.delete(kf.K.makeHash(201,36)); kf.state.objects = n; })()""")
        b.contexts[0].pages[0].evaluate("void 0")
        res.append(('no console errors', not errs))
        print(errs)
finally:
    out = b''
    proc.terminate()
    try: out = proc.communicate(timeout=5)[0]
    except Exception: proc.kill()
    print(out.decode(errors='replace')[-1500:])
for n, ok in res: print(('  ok   ' if ok else '  FAIL ') + n)
