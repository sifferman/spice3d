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
N -300 160 180 160 {lab=OUT0}
N -100 60 180 60 {lab=OUT1}
N -460 80 -420 80 {lab=IN0}
N -460 -20 -220 -20 {lab=IN1}
N -460 -120 -20 -120 {lab=IN2}
N 100 -120 180 -120 {lab=OUT3}
C {sky130_stdcells/ha_1.sym} 40 -80 0 0 {name=x4 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/ha_1.sym} -160 20 0 0 {name=x5 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {sky130_stdcells/ha_1.sym} -360 120 0 0 {name=x6 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR prefix=sky130_fd_sc_hd__ }
C {ipin.sym} -650 -90 0 0 {name=p19 lab=VGND}
C {ipin.sym} -650 -70 0 0 {name=p20 lab=VNB}
C {ipin.sym} -650 -50 0 0 {name=p21 lab=VPB}
C {ipin.sym} -650 -30 0 0 {name=p22 lab=VPWR}
C {lab_pin.sym} -420 160 2 1 {name=p3 sig_type=std_logic lab=VPWR}
C {ipin.sym} -460 80 0 0 {name=p1 lab=IN0}
C {ipin.sym} -460 -20 0 0 {name=p2 lab=IN1}
C {ipin.sym} -460 -120 0 0 {name=p4 lab=IN2}
C {opin.sym} 180 160 0 0 {name=p8 lab=OUT0}
C {opin.sym} 180 60 0 0 {name=p6 lab=OUT1}
C {opin.sym} 180 -40 0 0 {name=p7 lab=OUT2}
C {opin.sym} 180 -120 0 0 {name=p5 lab=OUT3}
