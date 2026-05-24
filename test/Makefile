CXX      ?= g++
CC       ?= gcc
CXXFLAGS ?= -std=c++17 -Wall -Wextra -O0 -g
CFLAGS   ?= -std=c11 -Wall -Wextra -O0 -g

X2S_DIR := ../third_party/xschem2spice/src
SRC_DIR := ../src
ZSTD_DIR := ../third_party/zstd

X2S_SRCS := $(X2S_DIR)/parser.c $(X2S_DIR)/netlist.c $(X2S_DIR)/hash.c $(X2S_DIR)/strutil.c $(X2S_DIR)/xschemrc.c
X2S_OBJS := $(X2S_SRCS:.c=.o)

LOADER_SRC := $(SRC_DIR)/scene/schematic_loader.cpp
LOADER_OBJ := $(LOADER_SRC:.cpp=.o)

EXTRACTOR_SRC := $(SRC_DIR)/pdk/zstd_tar_archive_extractor.cpp
EXTRACTOR_OBJ := $(EXTRACTOR_SRC:.cpp=.o)

EXAMPLES_DIR ?= ../project/examples

INCLUDES := -I$(X2S_DIR) -I$(SRC_DIR) -I$(ZSTD_DIR)/lib

ZSTD_STATIC_LIBRARY := $(ZSTD_DIR)/lib/libzstd.a

.PHONY: all run clean

all: test_schematic_loader test_zstd_tar_archive_extractor

test_schematic_loader: test_schematic_loader.cpp $(LOADER_OBJ) $(X2S_OBJS)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $@ $^

test_zstd_tar_archive_extractor: test_zstd_tar_archive_extractor.cpp $(EXTRACTOR_OBJ) $(ZSTD_STATIC_LIBRARY)
	$(CXX) $(CXXFLAGS) $(INCLUDES) -o $@ $^

$(ZSTD_STATIC_LIBRARY):
	$(MAKE) -C $(ZSTD_DIR)/lib libzstd.a

%.o: %.cpp
	$(CXX) $(CXXFLAGS) $(INCLUDES) -c -o $@ $<

%.o: %.c
	$(CC) $(CFLAGS) $(INCLUDES) -c -o $@ $<

run: all
	./test_schematic_loader $(EXAMPLES_DIR)
	./test_zstd_tar_archive_extractor

clean:
	rm -f test_schematic_loader test_zstd_tar_archive_extractor \
		$(LOADER_OBJ) $(EXTRACTOR_OBJ) $(X2S_OBJS)
