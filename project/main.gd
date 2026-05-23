extends Node


func _ready() -> void:
	var spice3d_root := Spice3DNode.new()
	add_child(spice3d_root)
	print("spice3d %s - backend: %s" % [
		spice3d_root.get_spice3d_version(),
		spice3d_root.describe_simulator_backend(),
	])
