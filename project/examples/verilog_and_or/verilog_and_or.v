module verilog_and_or (
    input  wire a,
    input  wire b,
    input  wire c,
    output wire y
);
    assign y = (a & b) | c;
endmodule
