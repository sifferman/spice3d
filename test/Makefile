CXX      ?= g++
CC       ?= gcc
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O0 -g
CFLAGS   ?= -std=c11 -Wall -Wextra -O0 -g

X2S_DIR := ../third_party/xschem2spice/src
SRC_DIR := ../src

X2S_SRCS := $(X2S_DIR)/parser.c $(X2S_DIR)/netlist.c $(X2S_DIR)/hash.c $(X2S_DIR)/strutil.c $(X2S_DIR)/xschemrc.c
X2S_OBJS := $(X2S_SRCS:.c=.o)

LOADER_SRC := $(SRC_DIR)/scene/schematic_loader.cpp
LOADER_OBJ := $(LOADER_SRC:.cpp=.o)

TEST_SRC := test_schematic_loader.cpp

EXAMPLES_DIR ?= ../project/examples

INCLUDES := -I$(X2S_DIR) -I$(SRC_DIR)

.PHONY: all run clean

all: test_schematic_loader

test_schematic_loader: $(TEST_SRC) $(LOADER_OBJ) $(X2S_OBJS)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $@ $^

%.o: %.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<

%.o: %.c
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

run: test_schematic_loader
	./test_schematic_loader $(EXAMPLES_DIR)

clean:
	rm -f test_schematic_loader $(LOADER_OBJ) $(X2S_OBJS)
