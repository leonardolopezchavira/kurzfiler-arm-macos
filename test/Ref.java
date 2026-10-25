import filemethods.*;
import filemethods.kurzweil.*;
import filemethods.wav.*;
import kurzobjects.*;
import kurzobjects.keymaps.*;
import kurzobjects.samples.*;
import kfcore.fillmodes.*;
import java.util.*;

/** Drives the original KurzFiler model classes headlessly to create reference files. */
public class Ref {
  static KFile open(String path, boolean merge) {
    KFile f = new KFile();
    if (merge) f.setFillMode(new FillModeMerge());
    f.importData(path, new LoadK2x00Method());
    f.updateList();
    return f;
  }
  static List<Integer> ids(KFile f, int type) {
    List<Integer> l = new ArrayList<Integer>();
    for (Integer i : f.getIDs()) if (KHash.getType(i) == type) l.add(i);
    return l;
  }
  public static void main(String[] a) throws Exception {
    String op = a[0];
    if (op.equals("roundtrip")) {           // in out
      KFile f = open(a[1], true); f.save(a[2]);
    } else if (op.equals("save")) {         // in format out   (format krz/k25/k26)
      KFile f = open(a[1], true);
      FileMethodInterface m = a[2].equals("krz") ? new SaveK2000Method() : a[2].equals("k25") ? new SaveK2500noKDFXMethod() : new SaveK2500withKDFXMethod();
      f.exportData(a[3], m);
    } else if (op.equals("wavimport")) {    // wav out
      KFile f = new KFile(); f.importData(a[1], new LoadWaveMethod()); f.save(a[2]);
    } else if (op.equals("import")) {       // base fillmode add out
      KFile f = open(a[1], true);
      FillMode fm = a[2].equals("fill") ? new FillModeFill() : a[2].equals("append") ? new FillModeAppend() : new FillModeMerge();
      f.setFillMode(fm);
      KFile o = open(a[3], true);
      f.importData(o);
      f.save(a[4]);
    } else if (op.equals("remap")) {        // in out
      KFile f = open(a[1], true); f.setFillMode(new FillModeFill()); f.remapIDs(); f.save(a[2]);
    } else if (op.equals("wavexport")) {    // in outbase
      KFile f = open(a[1], true);
      f.exportData(a[2], new SaveWaveMethod());
    } else if (op.equals("instrument") || op.equals("drums")) { // in out
      KFile f = open(a[1], true);
      KHashtable newObjects = new KHashtable();
      List<Integer> samples = ids(f, KHash.T_SAMPLE);
      KKeymap kk = new KKeymap();
      kk.setHash(KHash.generate(200, KHash.T_KEYMAP));
      kk.sampleId = 0; kk.basePitch = 0; kk.centsPerEntry = 100; kk.entriesPerVel = 127;
      VeloLevel vl;
      if (op.equals("instrument")) {
        kk.setName("chromatic Keymap"); kk.method = 3; kk.entrySize = 3;
        vl = kk.newLevel();
        for (Integer id : samples) {
          KSample ks = (KSample) f.getKObject(id);
          Iterator<Short> hi = ks.getIterator();
          while (hi.hasNext()) { short h = hi.next(); vl.setSample(ks, h, ks.getheader(h).rootkey - 12); }
        }
        vl.fillSpacesBetweenSamples();
      } else {
        kk.setName("Drum Keymap"); kk.method = 0x13; kk.entrySize = 5;
        vl = kk.newLevel();
        int j = 24;
        for (Integer id : samples) {
          KSample ks = (KSample) f.getKObject(id);
          Iterator<Short> hi = ks.getIterator();
          while (hi.hasNext()) { vl.setSample(ks, hi.next(), j); j++; }
        }
      }
      for (int j = 0; j < 8; j++) kk.velomapping[j] = vl;
      KProgram kp = new KProgram();
      kp.setHash(KHash.generate(200, KHash.T_PROGRAM));
      kp.setName(op.equals("instrument") ? "Instrument" : "Drumset");
      kp.makePGMblock();
      kp.addLayer(kk, ((KSample) f.getKObject(samples.get(0))).isStereo());
      newObjects.put(kk.getHash(), kk); newObjects.put(kp.getHash(), kp);
      f.setFillMode(new FillModeFill());
      f.importData(newObjects);
      f.save(a[2]);
    } else if (op.equals("velosplit")) {    // in out c0..c7  (levels of all keymaps in order)
      KFile f = open(a[1], true);
      Vector<VeloLevel> levels = new Vector<VeloLevel>();
      for (Integer id : ids(f, KHash.T_KEYMAP)) {
        KKeymap kk = new KKeymap((KKeymap) f.getKObject(id));
        if (!kk.isCompactable()) kk.setMethod((short) (kk.getMethod() | 2));
        for (int i = 0; i < kk.numLevels(); i++) levels.add(new VeloLevel(kk.getLevel(i)));
      }
      int[] wahl = new int[8];
      for (int i = 0; i < 8; i++) wahl[i] = Integer.parseInt(a[3 + i]);
      KKeymap kk = new KKeymap();
      short method = 3;
      kk.setHash(KHash.generate(200, KHash.T_KEYMAP));
      kk.setName("Velosplit Keymap");
      kk.sampleId = 0; kk.method = 3; kk.basePitch = 0; kk.centsPerEntry = 100; kk.entriesPerVel = 127; kk.entrySize = 3;
      VeloLevel vl = levels.elementAt(wahl[0]);
      method |= vl.getMethod();
      kk.insertMap(vl); kk.velomapping[0] = vl; vl.setRang(0);
      for (int i = 1; i < 8; i++) {
        vl = levels.elementAt(wahl[i]);
        if (vl == kk.velomapping[i - 1]) { kk.velomapping[i] = kk.velomapping[i - 1]; continue; }
        method |= vl.getMethod();
        kk.insertMap(vl); kk.velomapping[i] = vl; vl.setRang(kk.velomapping[i - 1].getRang() + 1);
      }
      kk.setMethod(method);
      KProgram kp = new KProgram();
      kp.setHash(KHash.generate(200, KHash.T_PROGRAM));
      kp.setName("Program");
      kp.makePGMblock(); kp.addLayer(kk, false);
      KHashtable no = new KHashtable(); no.put(kk.getHash(), kk); no.put(kp.getHash(), kp);
      f.setFillMode(new FillModeFill());
      f.importData(no);
      f.save(a[2]);
    } else if (op.equals("compact")) {      // in out
      KFile f = open(a[1], true);
      f.setFillMode(new FillModeMerge());
      for (Integer id : ids(f, KHash.T_KEYMAP)) if (f.getKObject(id) != null) f.compactKeymap(id);
      f.save(a[2]);
    } else if (op.equals("root")) {         // in note out
      KFile f = open(a[1], true);
      for (Integer id : ids(f, KHash.T_SAMPLE)) { KSample ks = (KSample) f.getKObject(id); if (!ks.isMultiRoot()) ks.setRootKey(a[2]); }
      f.save(a[3]);
    } else if (op.equals("altstart")) {     // in out
      KFile f = open(a[1], true);
      for (Integer id : ids(f, KHash.T_SAMPLE)) ((KSample) f.getKObject(id)).setAltStartToSampleEnd();
      f.save(a[2]);
    } else if (op.equals("deps")) {         // in : print dependants and users
      KFile f = open(a[1], true);
      for (Integer id : f.getIDs()) {
        System.out.println(Integer.toHexString(id) + " " + f.getKObject(id).getName() + " deps=" + f.getDirectDependants(id) + " rec=" + f.getDependantsRecursive(id) + " users=" + f.getUsers(id) + " info=" + f.getKObject(id).getDescription());
      }
    }
  }
}
