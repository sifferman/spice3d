v {xschem version=3.4.6 file_version=1.2}
G {}
K {}
V {}
S {}
E {}
N -200 -140 -100 -140 {lab=a}
N -200 -120 -100 -120 {lab=b}
N -200 -100 -100 -100 {lab=c}
N 100 -120 200 -120 {lab=y}
C {verilog_and_or.sym} 0 -120 0 0 {name=x1 VGND=VGND VNB=VNB VPB=VPB VPWR=VPWR}
C {button.sym} -380 -300 0 0 {name=VBUTTON_A}
C {button.sym} -380 -180 0 0 {name=VBUTTON_B}
C {button.sym} -380 -60 0 0 {name=VBUTTON_C}
C {lab_pin.sym} -240 -240 0 0 {name=p_btn_a_out sig_type=std_logic lab=a}
C {lab_pin.sym} -240 -120 0 0 {name=p_btn_b_out sig_type=std_logic lab=b}
C {lab_pin.sym} -240 0 0 0 {name=p_btn_c_out sig_type=std_logic lab=c}
C {lab_pin.sym} -200 -140 0 0 {name=p_and_or_a_in sig_type=std_logic lab=a}
C {lab_pin.sym} -200 -120 0 0 {name=p_and_or_b_in sig_type=std_logic lab=b}
C {lab_pin.sym} -200 -100 0 0 {name=p_and_or_c_in sig_type=std_logic lab=c}
C {lab_pin.sym} 200 -120 2 0 {name=p_and_or_y_out sig_type=std_logic lab=y}
