extends GutTest


var spice3d_node_under_test: Node = null


func before_each() -> void:
	spice3d_node_under_test = ClassDB.instantiate("Spice3DNode")


func after_each() -> void:
	if spice3d_node_under_test != null:
		spice3d_node_under_test.free()
		spice3d_node_under_test = null


func test_spice3d_class_is_registered_with_godot_class_db() -> void:
	assert_true(
			ClassDB.class_exists("Spice3DNode"),
			"GDExtension should register Spice3DNode in Godot's ClassDB.")


func test_spice3d_version_is_non_empty_string() -> void:
	var reported_version_string: String = spice3d_node_under_test.get_spice3d_version()
	assert_true(reported_version_string.length() > 0,
			"Spice3DNode.get_spice3d_version() should return a non-empty version string.")


func test_simulator_backend_description_mentions_platform() -> void:
	var backend_description: String = spice3d_node_under_test.describe_simulator_backend()
	assert_true(backend_description.length() > 0,
			"Spice3DNode.describe_simulator_backend() should return a non-empty description.")


func test_is_running_on_web_platform_returns_false_under_headless_linux() -> void:
	assert_false(spice3d_node_under_test.is_running_on_web_platform(),
			"Headless Linux test run should report not-web.")
