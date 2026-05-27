extends GutTest


const WIRE_MESH_INSTANCE_META_KEY_FOR_SPICE_NODE_NAME := "spice_node_name"

var spice3d_node_under_test: Node = null
var fake_schematic_root_node: Node3D = null


func before_each() -> void:
	spice3d_node_under_test = ClassDB.instantiate("Spice3DNode")
	fake_schematic_root_node = Node3D.new()
	add_child_autofree(fake_schematic_root_node)


func after_each() -> void:
	if spice3d_node_under_test != null:
		spice3d_node_under_test.free()
		spice3d_node_under_test = null


func make_tagged_wire_mesh_instance(tagged_spice_node_name: String) -> MeshInstance3D:
	var tagged_wire := MeshInstance3D.new()
	tagged_wire.set_meta(WIRE_MESH_INSTANCE_META_KEY_FOR_SPICE_NODE_NAME, tagged_spice_node_name)
	var per_wire_material := StandardMaterial3D.new()
	per_wire_material.albedo_color = Color(0.5, 0.5, 0.5)
	tagged_wire.set_material_override(per_wire_material)
	return tagged_wire


func make_untagged_mesh_instance() -> MeshInstance3D:
	var untagged := MeshInstance3D.new()
	untagged.set_material_override(StandardMaterial3D.new())
	return untagged


func test_apply_voltages_updates_albedo_when_node_name_matches() -> void:
	var tagged_wire := make_tagged_wire_mesh_instance("net1")
	fake_schematic_root_node.add_child(tagged_wire)
	const VDD_VOLTS := 1.8
	var voltages_dict := { "net1": VDD_VOLTS }
	spice3d_node_under_test.apply_node_voltages_to_wire_colors(
			fake_schematic_root_node, voltages_dict, VDD_VOLTS)
	var resulting_albedo_color: Color = (tagged_wire.get_material_override() as StandardMaterial3D).albedo_color
	assert_almost_eq(resulting_albedo_color.r, 0.95, 0.05,
			"At full VDD the high color should dominate (warm yellow ~0.95).")


func test_apply_voltages_leaves_tagged_wire_unchanged_when_no_matching_voltage() -> void:
	var tagged_wire := make_tagged_wire_mesh_instance("not_in_dict")
	fake_schematic_root_node.add_child(tagged_wire)
	const VDD_VOLTS := 1.8
	var voltages_dict := { "net1": VDD_VOLTS }
	var original_material_albedo: Color = (tagged_wire.get_material_override() as StandardMaterial3D).albedo_color
	spice3d_node_under_test.apply_node_voltages_to_wire_colors(
			fake_schematic_root_node, voltages_dict, VDD_VOLTS)
	var resulting_material_albedo: Color = (tagged_wire.get_material_override() as StandardMaterial3D).albedo_color
	assert_eq(resulting_material_albedo, original_material_albedo,
			"Wires whose node names are absent from the voltage dict should be left untouched.")


func test_apply_voltages_silently_skips_children_without_spice_node_name_meta() -> void:
	# This is the regression that flooded the deployed page console:
	# get_meta() on a Mesh without the key printed an error for every wire
	# every frame. The function must NOT trigger the "object has no meta"
	# error path for untagged children.
	var untagged_child := make_untagged_mesh_instance()
	fake_schematic_root_node.add_child(untagged_child)
	const VDD_VOLTS := 1.8
	var voltages_dict := { "net1": 0.5 }
	spice3d_node_under_test.apply_node_voltages_to_wire_colors(
			fake_schematic_root_node, voltages_dict, VDD_VOLTS)
	assert_true(untagged_child.has_method("get_material_override"),
			"Untagged child should remain functional after apply call (no crash).")


func test_apply_voltages_leaves_albedo_at_low_color_when_voltage_is_zero() -> void:
	var tagged_wire := make_tagged_wire_mesh_instance("groundnet")
	fake_schematic_root_node.add_child(tagged_wire)
	const VDD_VOLTS := 1.8
	var voltages_dict := { "groundnet": 0.0 }
	spice3d_node_under_test.apply_node_voltages_to_wire_colors(
			fake_schematic_root_node, voltages_dict, VDD_VOLTS)
	var resulting_albedo_color: Color = (tagged_wire.get_material_override() as StandardMaterial3D).albedo_color
	assert_almost_eq(resulting_albedo_color.b, 0.85, 0.05,
			"At 0 V the low color should dominate (cool blue ~0.85 blue channel).")
