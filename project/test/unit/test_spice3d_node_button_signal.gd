extends GutTest


var spice3d_node_under_test: Node = null
var captured_button_instance_names: Array[String] = []


func _on_button_pressed_signal_for_test(button_instance_name: String) -> void:
	captured_button_instance_names.append(button_instance_name)


func before_each() -> void:
	spice3d_node_under_test = ClassDB.instantiate("Spice3DNode")
	captured_button_instance_names.clear()
	spice3d_node_under_test.button_pressed.connect(_on_button_pressed_signal_for_test)


func after_each() -> void:
	if spice3d_node_under_test != null:
		spice3d_node_under_test.free()
		spice3d_node_under_test = null


func test_button_pressed_signal_is_registered_on_spice3d_node() -> void:
	var signal_descriptors: Array = spice3d_node_under_test.get_signal_list()
	var signal_names: Array[String] = []
	for one_signal_descriptor in signal_descriptors:
		signal_names.append(one_signal_descriptor["name"])
	assert_true(signal_names.has("button_pressed"),
			"Spice3DNode should expose a 'button_pressed' signal for click forwarding.")


func test_on_button_area_input_event_emits_signal_for_left_mouse_button_press() -> void:
	var pressed_left_mouse_button_event := InputEventMouseButton.new()
	pressed_left_mouse_button_event.button_index = MOUSE_BUTTON_LEFT
	pressed_left_mouse_button_event.pressed = true
	spice3d_node_under_test.on_button_area_input_event(
			null,
			pressed_left_mouse_button_event,
			Vector3.ZERO, Vector3.UP, 0,
			"VBUTTON1")
	assert_eq(captured_button_instance_names, ["VBUTTON1"],
			"Pressing the left mouse button on the area should emit 'button_pressed' once with the instance name.")


func test_on_button_area_input_event_ignores_right_mouse_button() -> void:
	var pressed_right_mouse_button_event := InputEventMouseButton.new()
	pressed_right_mouse_button_event.button_index = MOUSE_BUTTON_RIGHT
	pressed_right_mouse_button_event.pressed = true
	spice3d_node_under_test.on_button_area_input_event(
			null,
			pressed_right_mouse_button_event,
			Vector3.ZERO, Vector3.UP, 0,
			"VBUTTON1")
	assert_eq(captured_button_instance_names, [],
			"Right-click on a button area should NOT emit 'button_pressed'.")


func test_on_button_area_input_event_ignores_mouse_button_release() -> void:
	var released_left_mouse_button_event := InputEventMouseButton.new()
	released_left_mouse_button_event.button_index = MOUSE_BUTTON_LEFT
	released_left_mouse_button_event.pressed = false
	spice3d_node_under_test.on_button_area_input_event(
			null,
			released_left_mouse_button_event,
			Vector3.ZERO, Vector3.UP, 0,
			"VBUTTON1")
	assert_eq(captured_button_instance_names, [],
			"Mouse-up events should NOT emit 'button_pressed' (we only fire on press).")


func test_on_button_area_input_event_ignores_non_mouse_events() -> void:
	var key_event := InputEventKey.new()
	key_event.keycode = KEY_SPACE
	key_event.pressed = true
	spice3d_node_under_test.on_button_area_input_event(
			null,
			key_event,
			Vector3.ZERO, Vector3.UP, 0,
			"VBUTTON1")
	assert_eq(captured_button_instance_names, [],
			"Non-mouse events should NOT emit 'button_pressed'.")
