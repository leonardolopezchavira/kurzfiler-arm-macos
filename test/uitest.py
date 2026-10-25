import sys, os, json
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = 'file://' + os.path.join(os.path.dirname(HERE), 'app', 'index.html')
T = os.path.join(os.environ.get('KF_ORIG', os.path.join(HERE, '.work', 'kurzfiler')), 'tests') + '/'
AUDIO = os.path.join(HERE, '.work', 'audio') + '/'
SHOTS = os.path.join(HERE, '.work', 'shots') + '/'
os.makedirs(SHOTS, exist_ok=True)
errors = []
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('  ok   ' if cond else '  FAIL ') + name + (' ' + str(extra) if extra else ''))

with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ['light', 'dark']:
        ctx = b.new_context(viewport={'width': 1280, 'height': 800}, color_scheme=scheme, accept_downloads=True, device_scale_factor=2 if scheme == 'light' else 1)
        page = ctx.new_page(); page.set_default_timeout(5000)
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(APP)
        page.wait_for_timeout(300)
        if scheme == 'light':
            page.screenshot(path=SHOTS + '01-empty.png')
        # open a file through the Open command
        with page.expect_file_chooser() as fc:
            page.click('.empty [data-cmd=open]')
        fc.value.set_files([T + 'bug070516/OBJEP101.K26'])
        page.wait_for_timeout(500)
        n = page.evaluate('kf.state.objects.size')
        ok(scheme + ': open OBJEP101.K26', n == 184, n)
        page.click('#rows tr[data-h]:nth-child(1)')
        page.wait_for_timeout(200)
        page.screenshot(path=SHOTS + '02-%s-program.png' % scheme)
        if scheme == 'dark':
            ctx.close(); continue

        # filter + keymap inspector
        page.click('[data-filter=keymap]')
        page.click('#rows tr[data-h]:nth-child(2)')
        page.wait_for_timeout(200)
        page.screenshot(path=SHOTS + '03-keymap.png')
        ok('keymap inspector shows keyboard', page.locator('#kbd .k').count() >= 128)

        # open a file with real sample data (replaces document, nothing dirty)
        with page.expect_file_chooser() as fc:
            page.click('.toolbar [data-cmd=open]')
        fc.value.set_files([T + 'bug061029/kurz1 fixed.krz'])
        page.wait_for_timeout(500)
        ok('open kurz1 fixed.krz', page.evaluate('kf.state.objects.size') == 11)
        page.click('[data-filter=sample]')
        page.click('#rows tr[data-h]:nth-child(3)')
        page.wait_for_timeout(300)
        page.screenshot(path=SHOTS + '04-sample.png')
        ok('waveform drawn', page.evaluate("(() => { const c = document.querySelector('#wave'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()") > 1000)

        # import wav files (fill mode)
        with page.expect_file_chooser() as fc:
            page.click('.toolbar [data-cmd=import]')
        fc.value.set_files([T + 'Tralla16BitMonoLoop.wav', AUDIO + 'stereo16.wav', AUDIO + 'stereo.aiff'])
        page.wait_for_timeout(500)
        ids = page.evaluate("[...kf.state.sel].map(h => kf.K.typeName(h) + ' ' + kf.K.hashID(h))")
        ok('import 3 audio files -> samples 209..211 selected', ids == ['Sample 209', 'Sample 210', 'Sample 211'], ids)
        ok('file is dirty', page.evaluate('kf.state.objects !== kf.state.saved'))

        # Set root key via dialog for the 3 new samples
        page.keyboard.press('Control+r')
        page.wait_for_timeout(200)
        inputs = page.locator('#dlg-body input')
        ok('root key dialog lists 3 samples', inputs.count() == 3)
        inputs.nth(0).fill('E3'); inputs.nth(1).fill('Bb2'); inputs.nth(2).fill('62')
        page.screenshot(path=SHOTS + '05-rootkey.png')
        page.keyboard.press('Enter')
        page.wait_for_timeout(200)
        roots = page.evaluate("[...kf.state.sel].map(h => kf.state.objects.get(h).headers[0].rootkey)")
        ok('root keys set (E3=52, Bb2=46, 62)', roots == [52, 46, 62], roots)

        # New Instrument from all 9 original samples
        page.click('[data-filter=sample]')
        page.evaluate("kf.state.sel = new Set([...kf.state.objects.keys()].filter(h => kf.K.hashType(h) === 38 && kf.K.hashID(h) < 209)); kf.run('deselect'); 0")
        page.click('#rows tr[data-h]:nth-child(1)')
        page.click('#rows tr[data-h]:nth-child(9)', modifiers=['Shift'])
        ok('shift-click selects 9 samples', page.evaluate('kf.state.sel.size') == 9)
        page.click('#inspector [data-cmd=newInstrument]')
        page.wait_for_timeout(200)
        page.fill('#nn-k', 'Strings KM'); page.fill('#nn-p', 'My Strings')
        page.screenshot(path=SHOTS + '06-name-new.png')
        page.click('#dlg-buttons .primary')
        page.wait_for_timeout(300)
        made = page.evaluate("[...kf.state.sel].map(h => { const o = kf.state.objects.get(h); return o.typeName + ' ' + o.id + ' ' + o.name; })")
        ok('instrument created', made == ['Program 201 My Strings', 'Keymap 201 Strings KM'], made)
        page.screenshot(path=SHOTS + '07-created.png')
        deps = page.evaluate("kf.K.dependantsRecursive(kf.state.objects, kf.K.makeHash(201, 36)).length")
        ok('new program -> keymap -> 9 samples', deps == 10, deps)

        # inline rename with double click
        page.click('[data-filter=all]')
        row = page.locator('#rows tr[data-h]').first
        row.locator('td.name').dblclick()
        page.keyboard.press('Meta+a')
        page.keyboard.type('Renamed Program 1234567')
        page.keyboard.press('Enter')
        page.wait_for_timeout(200)
        nm = page.evaluate("kf.state.objects.get(kf.K.makeHash(200, 36)).name")
        ok('inline rename limited to 16 chars', nm == 'Renamed Program ', repr(nm))

        # delete program 200 with dependants -> only unused ones go
        page.evaluate("kf.state.sel = new Set([kf.K.makeHash(200, 36)])")
        page.evaluate("void kf.run('delete')")
        page.wait_for_timeout(200)
        txt = page.inner_text('#dlg-body')
        page.screenshot(path=SHOTS + '08-delete.png')
        page.click('#dlg-buttons .primary')
        page.wait_for_timeout(200)
        left = page.evaluate("[...kf.state.objects.values()].map(o => o.typeName + o.id).join(',')")
        ok('delete program + unused keymap only (samples still used by new keymap)', 'Program200' not in left and 'Keymap200' not in left and 'Sample200' in left, left)
        page.keyboard.press('Control+z')
        page.wait_for_timeout(200)
        ok('undo restores', 'Keymap 200' in page.evaluate("[...kf.state.objects.values()].map(o => o.typeName + ' ' + o.id).join(',')"))
        page.keyboard.press('Control+Shift+z')
        page.keyboard.press('Control+z')

        # velocity split from keymaps 200 and 201
        page.evaluate("kf.state.sel = new Set([kf.K.makeHash(200, 37), kf.K.makeHash(201, 37)]); void kf.run('velosplit')")
        page.wait_for_timeout(200)
        page.screenshot(path=SHOTS + '09-velosplit.png')
        page.click('#dlg-buttons .primary'); page.wait_for_timeout(150)
        page.click('#dlg-buttons .primary'); page.wait_for_timeout(250)
        ok('velocity split created', page.evaluate("kf.state.objects.get(kf.K.makeHash(202, 37)).numLevels()") == 2)

        # compact keymap 200
        page.evaluate("kf.state.sel = new Set([kf.K.makeHash(200, 37)]); void kf.run('compact')")
        page.wait_for_timeout(300)
        info = page.evaluate("(() => { const s = [...kf.state.objects.values()].filter(o => o instanceof kf.K.KSample && o.multiRoot); return s.map(x => x.id + ':' + x.headers.length); })()")
        ok('compact keymap made a multi-root sample', info == ['200:9'], info)

        # save as K2000 -> download, verify it parses and matches the core's own writer
        page.evaluate("void kf.run('saveAs')")
        page.wait_for_timeout(200)
        page.screenshot(path=SHOTS + '10-saveas.png')
        page.check('input[name=fmt][value=krz]')
        with page.expect_download() as dl:
            page.click('#dlg-buttons .primary')
        path = dl.value.path()
        data = open(path, 'rb').read()
        ok('saved .krz download', data[:4] == b'PRAM' and dl.value.suggested_filename.endswith('.krz'), dl.value.suggested_filename + ' ' + str(len(data)))
        ok('not dirty after save', page.evaluate('kf.state.objects === kf.state.saved'))
        open(os.path.join(HERE, '.work', 'ui-saved.krz'), 'wb').write(data)

        # file info + fill mode dialogs
        page.evaluate("void kf.run('fileInfo')"); page.wait_for_timeout(150)
        page.screenshot(path=SHOTS + '11-fileinfo.png'); page.keyboard.press('Escape')
        page.evaluate("void kf.run('fillMode')"); page.wait_for_timeout(150)
        page.screenshot(path=SHOTS + '12-fillmode.png'); page.keyboard.press('Escape')

        # export wav
        page.evaluate("kf.state.sel = new Set([kf.K.makeHash(210, 38)])")
        with page.expect_download() as dl:
            page.evaluate("void kf.run('exportWav')")
        ok('export wav download', dl.value.suggested_filename.endswith('.wav'), dl.value.suggested_filename)

        # html menubar
        page.click('#menubar .mb:nth-child(3) > button')
        page.wait_for_timeout(100)
        page.screenshot(path=SHOTS + '13-menu.png')
        page.keyboard.press('Escape')
        page.mouse.click(700, 400)
        ctx.close()
    b.close()

ok('no console errors', not errors, errors[:5])
print(sum(1 for r in results if r[1]), 'passed,', sum(1 for r in results if not r[1]), 'failed')
