v {xschem version=3.4.6 file_version=1.2}
G {}
K {}
V {}
S {}
E {}
N 100 -40 180 -40 {lab=#net1}
N -100 -20 -60 -20 {lab=#net2}
N -60 -40 -20 -40 {lab=#net2}
N -60 -40 -60 -20 {lab=#net2}
N -300 80 -260 80 {lab=#net3}
N -260 60 -220 60 {lab=#net3}
N -260 60 -260 80 {lab=#net3}
N -300 160 180 160 {lab=#net4}
N -100 60 180 60 {lab=#net5}
N -60 -120 -20 -120 {lab=#net6}
N -60 -190 -60 -120 {lab=#net6}
N -60 -190 400 -190 {lab=#net6}
N 400 -190 400 -60 {lab=#net6}
N 360 -60 400 -60 {lab=#net6}
N 360 40 450 40 {lab=#net7}
N 450 -240 450 40 {lab=#net7}
N -260 -240 450 -240 {lab=#net7}
N -260 -240 -260 -20 {lab=#net7}
N -260 -20 -220 -20 {lab=#net7}
N 360 140 500 140 {lab=#net8}
N 500 -290 500 140 {lab=#net8}
N -460 -290 500 -290 {lab=#net8}
N -460 -290 -460 80 {lab=#net8}
N -460 80 -420 80 {lab=#net8}
C {sky130_stdcells/dfxtp_1.sym} 270 -50 0 0 {name=x1 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/dfxtp_1.sym} 270 50 0 0 {name=x2 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/ha_1.sym} 40 -80 0 0 {name=x4 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/ha_1.sym} -160 20 0 0 {name=x5 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/dfxtp_1.sym} 270 150 0 0 {name=x3 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/ha_1.sym} -360 120 0 0 {name=x6 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {lab_pin.sym} 180 -60 2 1 {name=p51 sig_type=std_logic lab=CLK}
C {lab_pin.sym} 180 40 2 1 {name=p1 sig_type=std_logic lab=CLK}
C {lab_pin.sym} 180 140 2 1 {name=p2 sig_type=std_logic lab=CLK}
C {ipin.sym} -520 -90 0 0 {name=p19 lab=VGND}
C {ipin.sym} -520 -70 0 0 {name=p20 lab=VNB}
C {ipin.sym} -520 -50 0 0 {name=p21 lab=VPB}
C {ipin.sym} -520 -30 0 0 {name=p22 lab=VPWR}
C {lab_pin.sym} -420 160 2 1 {name=p3 sig_type=std_logic lab=VPWR}
