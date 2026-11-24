"""Build the optional v4.18.42 component from the pinned Windows Node archive."""
import argparse
import hashlib
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

SOURCE_HASH = "77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed"
PACKAGE_HASH = "6cf1e5a802ae40420a94474766992e153001092a69828ff87d5eca476375e5da"
NOTICE = ("NapCatQQ v4.18.42 / Copyright Mlikiowa. Source: https://github.com/NapNeko/NapCatQQ. "
          "Unmodified core from https://github.com/XingYunStar/NapCatQQ/releases/tag/v4.18.42 "
          "(archived distribution). Non-commercial use only; see NapCat-LICENSE.txt. "
          "Drop this ZIP into Unusual Quick Start. First activation retrieves the pinned Windows runtime archive.\n")
CORE = ("napcat/napcat.mjs", "napcat/package.json", "napcat/config/napcat.json")


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if digest(args.source) != SOURCE_HASH:
        parser.error("Input ZIP differs from the pinned archive")
    license_file = Path(__file__).resolve().parents[1] / "licenses/napcat/LICENSE.txt"
    # Preserve the released upstream license bytes across Git line-ending settings.
    license_bytes = license_file.read_bytes().replace(b"\r\n", b"\n")
    with ZipFile(args.source) as source, ZipFile(args.output, "x") as dest:
        entries = [(name, source.read(name)) for name in CORE]
        entries.extend([("NapCat-LICENSE.txt", license_bytes), ("README.txt", NOTICE.encode())])
        for name, data in entries:
            entry = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.create_system = 0
            entry.compress_type = ZIP_DEFLATED
            dest.writestr(entry, data)
    if digest(args.output) != PACKAGE_HASH:
        parser.error("Output differs from the published bytes. Check Python/zlib and license line endings.")


if __name__ == "__main__":
    main()
