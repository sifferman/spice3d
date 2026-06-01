v {xschem version=3.4.6 file_version=1.2}
G {}
K {}
V {}
S {}
E {}
N -20 20 -20 60 {lab=state_d[2:0] bus=true}
N -20 40 80 40 {lab=state_d[2:0] bus=true}
N 260 20 340 20 {lab=state_q[2:0] bus=true}
N 340 -60 340 20 {lab=state_q[2:0] bus=true}
N -400 -60 340 -60 {lab=state_q[2:0] bus=true}
N -340 20 -340 60 {lab=state_q[2:0] bus=true}
N -400 40 -340 40 {lab=state_q[2:0] bus=true}
N -400 -60 -400 40 {lab=state_q[2:0] bus=true}
C {sky130_stdcells/dfxtp_1.sym} 170 30 0 0 {name=xdff[2:0] VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {button.sym} -60 -240 0 0 {name=VBUTTON_CLK}
C {lab_pin.sym} 80 -180 0 0 {name=p_btn_clk sig_type=std_logic lab=CLK}
C {lab_pin.sym} 80 20 2 1 {name=p51 sig_type=std_logic lab=CLK}
C {3bit_incrementor.sym} -180 70 0 0 {name=x4 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR}
C {bus_tap.sym} -340 20 0 0 {name=r6 lab=[2]}
C {bus_tap.sym} -340 40 0 0 {name=r5 lab=[1]}
C {bus_tap.sym} -340 60 0 0 {name=r7 lab=[0]}
C {bus_tap.sym} -20 20 2 0 {name=r2 lab=[2]}
C {bus_tap.sym} -20 40 2 0 {name=r3 lab=[1]}
C {bus_tap.sym} -20 60 2 0 {name=r4 lab=[0]}
C {lab_pin.sym} 80 40 3 0 {name=pd sig_type=std_logic lab=state_d[2:0]}
C {lab_pin.sym} 340 20 2 0 {name=pq sig_type=std_logic lab=state_q[2:0]}
