extends Node

# Bootstrap: instantiates the Spice3DNode from the spice3d GDExtension and
# prints its version + backend so we can confirm the native library loaded.
# As more of the simulator lands, the real scene assembly will move into C++
# inside Spice3DNode itself; this script stays minimal on purpose.

func _ready() -> void:
	var s3d := Spice3DNode.new()
	add_child(s3d)
	print("spice3d %s — backend: %s" % [s3d.version(), s3d.simulator_backend()])
