"""Builds KurzFiler.app (Apple Silicon) from the official Electron macOS arm64 runtime."""
import os, plistlib, shutil, subprocess, zipfile, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = os.environ.get('ELECTRON_ZIP', ROOT + '/build/cache/electron-v39.2.7-darwin-arm64.zip')
RC = os.environ.get('RCODESIGN', 'rcodesign')
OUT = ROOT + '/dist'
APP = OUT + '/KurzFiler.app'
BUNDLE_ID = 'io.github.kurzfiler.mac'
VERSION = '2.0.0'

shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT)
# unzip preserving symlinks and permissions (Python's zipfile drops them, so use unzip)
subprocess.check_call(['unzip', '-q', ZIP, 'Electron.app/*', '-d', OUT])
os.rename(OUT + '/Electron.app', APP)
res = APP + '/Contents/Resources'
for f in ['default_app.asar']:
    p = os.path.join(res, f)
    if os.path.exists(p): os.remove(p)
os.remove(res + '/electron.icns')
shutil.copy(ROOT + '/build/kurzfiler.icns', res + '/kurzfiler.icns')
os.makedirs(res + '/app')
for f in ['index.html', 'app.css', 'app.js', 'krz-core.js', 'main.js', 'preload.js', 'package.json']:
    shutil.copy(os.path.join(ROOT, 'app', f), res + '/app/' + f)
shutil.copy(ROOT + '/LICENSE', res + '/app/LICENSE')

doc_types = [{
    'CFBundleTypeName': 'Kurzweil K2000/K2500/K2600 File',
    'CFBundleTypeRole': 'Editor',
    'LSHandlerRank': 'Owner',
    'CFBundleTypeExtensions': ['krz', 'k25', 'k26', 'KRZ', 'K25', 'K26'],
    'CFBundleTypeIconFile': 'kurzfiler.icns',
    'LSItemContentTypes': ['io.github.kurzfiler.krz'],
}]
utis = [{
    'UTTypeIdentifier': 'io.github.kurzfiler.krz',
    'UTTypeDescription': 'Kurzweil K2000/K2500/K2600 File',
    'UTTypeConformsTo': ['public.data'],
    'UTTypeIconFile': 'kurzfiler.icns',
    'UTTypeTagSpecification': {'public.filename-extension': ['krz', 'k25', 'k26']},
}]
pl_path = APP + '/Contents/Info.plist'
with open(pl_path, 'rb') as f: pl = plistlib.load(f)
pl.update({
    'CFBundleName': 'KurzFiler', 'CFBundleDisplayName': 'KurzFiler', 'CFBundleIdentifier': BUNDLE_ID,
    'CFBundleShortVersionString': VERSION, 'CFBundleVersion': VERSION, 'CFBundleIconFile': 'kurzfiler.icns',
    'CFBundleDocumentTypes': doc_types, 'UTExportedTypeDeclarations': utis,
    'LSApplicationCategoryType': 'public.app-category.music',
    'NSHumanReadableCopyright': 'GNU GPL v3 or later. Based on KurzFiler by Marc Halbrügge and Sven Thoennissen.',
})
for k in ['ElectronAsarIntegrity', 'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription', 'NSCameraUsageDescription', 'NSAudioCaptureUsageDescription']:
    pl.pop(k, None)
with open(pl_path, 'wb') as f: plistlib.dump(pl, f)
# helper bundle ids
fw = APP + '/Contents/Frameworks'
for name in os.listdir(fw):
    if name.startswith('Electron Helper') and name.endswith('.app'):
        hp = fw + '/' + name + '/Contents/Info.plist'
        with open(hp, 'rb') as f: h = plistlib.load(f)
        suffix = name[len('Electron Helper'):-4].strip(' ()').lower().replace(' ', '')
        h['CFBundleExecutable'] = name[:-4]
        h['CFBundleIdentifier'] = BUNDLE_ID + '.helper' + ('.' + suffix if suffix else '')
        with open(hp, 'wb') as f: plistlib.dump(h, f)

# ad-hoc code signature for the whole bundle (required for Apple Silicon)
subprocess.check_call([RC, 'sign', APP], stdout=subprocess.DEVNULL)
print('signed')
info = subprocess.run([RC, 'print-signature-info', APP], capture_output=True, text=True).stdout
print('\n'.join(l for l in info.splitlines() if 'identifier' in l or 'flags' in l or 'path' in l)[:3000])

# zip with symlinks kept
os.chdir(OUT)
shutil.copy(ROOT + '/build/How to install.txt', OUT + '/How to install.txt')
subprocess.check_call(['zip', '-qry', 'KurzFiler-mac-arm64.zip', 'KurzFiler.app', 'How to install.txt'])
print(os.path.getsize('KurzFiler-mac-arm64.zip') // 1048576, 'MB')
