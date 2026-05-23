extends Control

@onready var status_label: Label = $StatusLabel


func _ready() -> void:
	var spice3d_root := Spice3DNode.new()
	add_child(spice3d_root)
	var status_text := "spice3d %s\nbackend: %s" % [
		spice3d_root.get_spice3d_version(),
		spice3d_root.describe_simulator_backend(),
	]
	status_label.text = status_text
	print(status_text)
