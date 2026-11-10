from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
MANIFEST = HERE / "recomplauncher.json"


def main() -> None:
    if not MANIFEST.is_file():
        raise SystemExit(f"RecompLauncher profile is missing: {MANIFEST}")
    if not DIST.is_dir():
        raise SystemExit(f"Release output directory is missing: {DIST}")

    data = MANIFEST.read_bytes()
    archives = sorted(DIST.glob("*.zip"))
    for archive_path in archives:
        with ZipFile(archive_path, "a", compression=ZIP_DEFLATED) as archive:
            if "recomplauncher.json" not in archive.namelist():
                archive.write(MANIFEST, "recomplauncher.json")
        with ZipFile(archive_path, "r") as archive:
            if archive.read("recomplauncher.json") != data:
                raise SystemExit(
                    f"{archive_path.name} does not contain the current root recomplauncher.json"
                )
        print(f"Verified recomplauncher.json at ZIP root: {archive_path.name}")

    if not archives:
        print("No ZIP target on this platform; the afterPack hook embeds the profile in the AppDir.")


if __name__ == "__main__":
    main()
