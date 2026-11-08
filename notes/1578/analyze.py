import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "probe"))
import probe as p  # noqa: E402

root = os.path.join(HERE, "results")
for tag in sorted(os.listdir(root)):
    for label in sorted(os.listdir(os.path.join(root, tag))):
        d = os.path.join(root, tag, label)
        if not os.path.isdir(d):
            continue
        res = json.load(open(os.path.join(d, "result.json")))
        chunks = p.chunks_of(os.path.join(d, "outer.bin"))
        joined = b""
        t_end = None
        for t, data in chunks:
            joined += data
            if b"END-OF-REPLY" in joined:
                t_end = t
                break
        quiet = next(i for i, (t, _) in enumerate(chunks) if t > t_end + 2.05)
        out = {k: res[k] for k in ("agent", "where", "termProgram", "relay", "ownSyncOn", "outerSyncOn", "ownOsc8Links", "outerOsc8Links")}
        out["label"] = tag + "/" + label
        out["scrollPaintsOutside"] = p.painted_bursts(chunks[quiet:])
        print(json.dumps(out))
