#!/usr/bin/env bash
set -euo pipefail

# Runs the exact testbench shape main.gd produces (PDK .lib include,
# inlined sky130_fd_sc_hd__inv_1 subckt, rail sources, button_test
# body, transient stimulus) through the real local ngspice binary.
# Fails non-zero if v(btn_out_n) doesn't actually invert v(net1).

if [[ -z "${PDK_ROOT:-}" || ! -d "$PDK_ROOT/sky130A" ]]; then
	echo "PDK_ROOT not set or sky130A not present; skipping local ngspice check." >&2
	exit 0
fi

ngspice_executable_path="${NGSPICE_EXECUTABLE_PATH:-ngspice}"
if ! command -v "$ngspice_executable_path" >/dev/null 2>&1; then
	echo "ngspice binary not on PATH; skipping local ngspice check." >&2
	exit 0
fi

scratch_netlist_file="$(mktemp --suffix=.sp)"
trap 'rm -f "$scratch_netlist_file"' EXIT

cat > "$scratch_netlist_file" <<EOF
spice3d testbench shape that main.gd produces
.lib $PDK_ROOT/sky130A/libs.tech/combined/sky130.lib.spice tt
.subckt sky130_fd_sc_hd__inv_1 A VGND VNB VPB VPWR Y
X0 VGND A Y VNB sky130_fd_pr__nfet_01v8 w=650000u l=150000u
X1 Y A VPWR VPB sky130_fd_pr__pfet_01v8_hvt w=1e+06u l=150000u
.ends
V_SPICE3D_TESTBENCH_VPWR VPWR 0 DC 1.8
V_SPICE3D_TESTBENCH_VGND VGND 0 DC 0
V_SPICE3D_TESTBENCH_VPB  VPB  0 DC 1.8
V_SPICE3D_TESTBENCH_VNB  VNB  0 DC 0
VBUTTON1 net1 VGND PULSE(0 1.8 100n 1n 1n 1u 5u)
x1 net1 VGND VNB VPB VPWR btn_out_n sky130_fd_sc_hd__inv_1
.tran 10n 2u
.print tran v(net1) v(btn_out_n)
.end
EOF

simulation_output_file="$(mktemp)"
trap 'rm -f "$scratch_netlist_file" "$simulation_output_file"' EXIT

"$ngspice_executable_path" -b "$scratch_netlist_file" 2>&1 > "$simulation_output_file"

python3 - "$simulation_output_file" <<'PY'
import sys, re

simulation_output_file_path = sys.argv[1]
samples_with_input_and_output_volts = []
table_row_pattern = re.compile(r'^\d+\s+(\S+)\s+(\S+)\s+(\S+)')
with open(simulation_output_file_path) as f:
    for one_line in f:
        match = table_row_pattern.match(one_line)
        if not match: continue
        t, v_in, v_out = (float(x) for x in match.groups())
        samples_with_input_and_output_volts.append((t, v_in, v_out))

if not samples_with_input_and_output_volts:
    sys.exit("no transient samples parsed from ngspice output")

peak_input_low_output_volts = max(
        v_out for (t, v_in, v_out) in samples_with_input_and_output_volts if v_in < 0.1)
trough_input_high_output_volts = min(
        v_out for (t, v_in, v_out) in samples_with_input_and_output_volts if v_in > 1.7)

if peak_input_low_output_volts < 1.7:
    sys.exit(f"v(btn_out_n) should be near VDD when v(net1)~0; max observed {peak_input_low_output_volts:.3f} V")
if trough_input_high_output_volts > 0.2:
    sys.exit(f"v(btn_out_n) should be near 0 when v(net1)~VDD; min observed {trough_input_high_output_volts:.3f} V")

print(f"PASS — inverter inverts: v(net1)~0 -> v(out)>={peak_input_low_output_volts:.3f}, "
        f"v(net1)~VDD -> v(out)<={trough_input_high_output_volts:.3f}")
PY
