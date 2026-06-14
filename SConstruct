#!/usr/bin/env python
import os
import sys

from methods import print_error


libname = "spice3d"
projectdir = "project"

localEnv = Environment(tools=["default"], PLATFORM="")

# Build profiles can be used to decrease compile times.
# You can either specify "disabled_classes", OR
# explicitly specify "enabled_classes" which disables all other classes.
# Modify the example file as needed and uncomment the line below or
# manually specify the build_profile parameter when running SCons.

# localEnv["build_profile"] = "build_profile.json"

customs = ["custom.py"]
customs = [os.path.abspath(path) for path in customs]

opts = Variables(customs, ARGUMENTS)
opts.Update(localEnv)

Help(opts.GenerateHelpText(localEnv))

env = localEnv.Clone()

if not (os.path.isdir("godot-cpp") and os.listdir("godot-cpp")):
    print_error("""godot-cpp is not available within this folder, as Git submodules haven't been initialized.
Run the following command to download godot-cpp:

    git submodule update --init --recursive""")
    sys.exit(1)

env = SConscript("godot-cpp/SConstruct", {"env": env, "customs": customs})

env.Append(CPPPATH=["src/", "third_party/xschem2spice/src/", "third_party/zstd/lib/"])

# Native builds (linux/macos/windows) link libngspice for the
# LibngspiceSpiceSimulator. Web build uses the ngspice WASM module loaded
# in a Worker instead. Require `scripts/build-ngspice-for-native.sh` to
# have been run first; SConstruct refuses to proceed if its artifacts are
# missing so the failure mode is "obvious early" rather than a cryptic
# undefined-reference link error later.
if env["platform"] != "web":
    ngspice_native_include_directory = "third_party/ngspice/src/include"
    ngspice_native_library_directory = "third_party/ngspice/build-native/src/.libs"
    ngspice_native_shared_library_path = ngspice_native_library_directory + "/libngspice.so"
    if not (os.path.isdir(ngspice_native_include_directory)
            and os.path.isfile(ngspice_native_shared_library_path)):
        print_error("""ngspice native build is missing. Run:

    scripts/build-ngspice-for-native.sh

before invoking scons for a native target (platform={}).""".format(env["platform"]))
        sys.exit(1)
    env.Append(CPPPATH=[ngspice_native_include_directory])
    env.Append(LIBPATH=[ngspice_native_library_directory])
    env.Append(LIBS=["ngspice"])
    env.Append(RPATH=[env.Literal("\\$$ORIGIN/../../../third_party/ngspice/build-native/src/.libs")])

# xschem2spice ships a tiny CLI driver in xschem2spice.c that has its own
# main() — exclude it. We link the library sources directly into the
# GDExtension instead of building a separate static library.
xschem2spice_sources = [
    f for f in Glob("third_party/xschem2spice/src/*.c")
    if str(f).split("/")[-1] != "xschem2spice.c"
]

# zstd is decompress-only here; ZSTD_DISABLE_ASM excludes the x86_64
# assembly path so the same source list compiles for web (wasm32) and any
# non-x86 native target. Applied on a cloned env so the define is scoped to
# zstd's own .c files — adding it globally would change every other .o's
# compile flags and invalidate the entire SCons cache on every rebuild.
zstd_decompress_env = env.Clone()
zstd_decompress_env.Append(CPPDEFINES=["ZSTD_DISABLE_ASM=1"])
zstd_decompress_objects = [
    zstd_decompress_env.SharedObject(source=one_source)
    for one_source in (
        Glob("third_party/zstd/lib/common/*.c")
        + Glob("third_party/zstd/lib/decompress/*.c")
    )
]

sources = (
    Glob("src/*.cpp")
    + Glob("src/sim/*.cpp")
    + Glob("src/sim/native/*.cpp")
    + Glob("src/sim/web/*.cpp")
    + Glob("src/scene/*.cpp")
    + Glob("src/pdk/*.cpp")
    + xschem2spice_sources
    + zstd_decompress_objects
)

if env["target"] in ["editor", "template_debug"]:
    try:
        doc_data = env.GodotCPPDocData("src/gen/doc_data.gen.cpp", source=Glob("doc_classes/*.xml"))
        sources.append(doc_data)
    except AttributeError:
        print("Not including class reference as we're targeting a pre-4.3 baseline.")

# .dev doesn't inhibit compatibility, so we don't need to key it.
# .universal just means "compatible with all relevant arches" so we don't need to key it.
suffix = env['suffix'].replace(".dev", "").replace(".universal", "")

lib_filename = "{}{}{}{}".format(env.subst('$SHLIBPREFIX'), libname, suffix, env.subst('$SHLIBSUFFIX'))

library = env.SharedLibrary(
    "bin/{}/{}".format(env['platform'], lib_filename),
    source=sources,
)

copy = env.Install("{}/bin/{}/".format(projectdir, env["platform"]), library)

default_args = [library, copy]
Default(*default_args)
