"""Creates the audio test files used by audiotest.js and uitest.py in test/.work/audio."""
import wave, struct, math, os, sys
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.work', 'audio')
os.makedirs(D, exist_ok=True); os.chdir(D)
def sig(n, ch):
    return [[int(12000*math.sin(i*0.05*(c+1))) for c in range(ch)] for i in range(n)]
def w16(fn, ch, n=3000, rate=44100):
    w=wave.open(fn,'wb'); w.setnchannels(ch); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes(b''.join(struct.pack('<'+'h'*ch,*f) for f in sig(n,ch))); w.close()
w16('stereo16.wav',2); w16('mono16_22k.wav',1,rate=22050)
w=wave.open('mono8.wav','wb'); w.setnchannels(1); w.setsampwidth(1); w.setframerate(44100)
w.writeframes(bytes((x[0]>>8)+128 for x in sig(3000,1))); w.close()
w=wave.open('stereo24.wav','wb'); w.setnchannels(2); w.setsampwidth(3); w.setframerate(44100)
w.writeframes(b''.join(b''.join(struct.pack('<i',v<<8)[0:3] for v in f) for f in sig(3000,2))); w.close()
data=b''.join(struct.pack('<ff',*[v/32767 for v in f]) for f in sig(3000,2))
fmt=struct.pack('<HHIIHH',3,2,44100,44100*8,8,32)
riff=b'WAVE'+b'fmt '+struct.pack('<I',16)+fmt+b'data'+struct.pack('<I',len(data))+data
open('stereofloat.wav','wb').write(b'RIFF'+struct.pack('<I',len(riff))+riff)
def ext80(x):
    e=int(math.floor(math.log2(x))); m=int(x/2**e*2**63)
    return struct.pack('>HQ',e+16383,m)
ssnd=struct.pack('>II',0,0)+b''.join(struct.pack('>hh',*f) for f in sig(3000,2))
comm=struct.pack('>hIh',2,3000,16)+ext80(44100)
mark=struct.pack('>H',2)+struct.pack('>HIB',1,1000,0)+b'\0'+struct.pack('>HIB',2,2500,0)+b'\0'
inst=bytes([67,0,0,127,1,127])+struct.pack('>h',0)+struct.pack('>HHH',1,1,2)+struct.pack('>HHH',0,0,0)
def ck(i,b): return i+struct.pack('>I',len(b))+b+(b'\0' if len(b)&1 else b'')
body=b'AIFF'+ck(b'COMM',comm)+ck(b'MARK',mark)+ck(b'INST',inst)+ck(b'SSND',ssnd)
open('stereo.aiff','wb').write(b'FORM'+struct.pack('>I',len(body))+body)
print('audio fixtures in', D)
