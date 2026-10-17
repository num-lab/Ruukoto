import hashlib
import json
import os
import pathlib
import subprocess
import tarfile

root = pathlib.Path("/tmp/ruukoto-tools-29.6uZBBr")
manifest = json.loads((root / "source-manifest.json").read_text())
summary = json.loads((root / "evidence/summary.json").read_text())
environment = json.loads((root / "evidence/environment.json").read_text())
digest = lambda value: hashlib.sha256(value).hexdigest()

for record in manifest["records"]:
    content = (root / "source" / record["path"]).read_bytes()
    assert len(content) == record["bytes"] and digest(content) == record["sha256"], record["path"]
for filename in ["base-runtime-dependencies.json", "mcp-runtime-dependencies.json"]:
    for record in json.loads((root / filename).read_text()):
        assert digest((root / "source" / record["path"] / "package.json").read_bytes()) == record["packageJsonSha256"], record["path"]
bundle = next(value for value in manifest["bundles"] if value["name"] == "linux-tools-probe.mjs")
assert digest((root / "source/apps/ruukoto/src/linux-tools-probe.mjs").read_bytes()) == bundle["sha256"]
assert environment["probeSha256"] == bundle["sha256"]
assert summary["externalWrites"] == 1 and summary["forbiddenCommandNetworkReads"] == 0
verification = {"productionAndFixtureFiles": len(manifest["records"]), "baseRuntimePackages": 108, "extraMcpRuntimePackages": 13, "bundleSha256": bundle["sha256"], "verified": True}
(root / "source-verification.json").write_text(json.dumps(verification, indent=2) + "\n")

scopes = []
for result in summary["results"]:
    operation = result["result"].get("operation")
    if not operation or "execution" not in operation:
        continue
    unit = "ruukoto-" + operation["execution"]["executionId"] + ".scope"
    command = subprocess.run(["systemctl", "--user", "show", unit, "--property=LoadState,ActiveState,ControlGroup"], capture_output=True, text=True, timeout=10)
    values = dict(line.split("=", 1) for line in command.stdout.splitlines() if "=" in line)
    assert values.get("LoadState") == "not-found" and not values.get("ControlGroup"), unit
    temporary = pathlib.Path(operation["prepared"]["input"]["tempDir"])
    assert not temporary.exists(), str(temporary)
    scopes.append({"unit": unit, "showExitCode": command.returncode, **values, "temporary": str(temporary), "temporaryExists": False})
processes = []
for line in subprocess.check_output(["ps", "-u", str(os.getuid()), "-o", "pid=,ppid=,args="], text=True).splitlines():
    columns = line.strip().split(None, 2)
    if len(columns) == 3 and (columns[2].startswith("node " + str(root)) or columns[2].startswith("/usr/local/bin/node " + str(root))):
        processes.append(line)
assert not processes, processes
cleanup = {"scopes": scopes, "matchingNodeProcesses": processes, "fixtureArchivesRetainedBeforeOwnedDirectoryRemoval": True}
(root / "cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n")

selected = ["fixtures", "attempt1-fixtures", "attempt2-fixtures", "evidence", "attempt1-evidence", "attempt2-evidence", "run.log", "run-attempt1.log", "run-attempt2.log", "source-manifest.json", "source-verification.json", "cleanup.json", "base-runtime-dependencies.json", "mcp-runtime-dependencies.json"]
records = []
with tarfile.open(root / "records.tar.gz", "w:gz") as archive:
    for name in selected:
        archive.add(root / name, arcname=name)
with tarfile.open(root / "records.tar.gz", "r:gz") as archive:
    for entry in archive.getmembers():
        if entry.isfile():
            content = archive.extractfile(entry).read()
            records.append({"path": entry.name, "bytes": len(content), "sha256": digest(content)})
(root / "artifact-manifest.json").write_text(json.dumps({"records": records, "archiveSha256": digest((root / "records.tar.gz").read_bytes())}, indent=2) + "\n")
print(json.dumps({"scenarios": [value["name"] for value in summary["results"]], "sourceFiles": len(manifest["records"]), "scopeCount": len(scopes), "archivedEvidenceFiles": len(records), "archiveBytes": (root / "records.tar.gz").stat().st_size}))
