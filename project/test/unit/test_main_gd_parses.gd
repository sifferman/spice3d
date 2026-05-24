extends GutTest


func test_main_gd_loads_without_parse_errors() -> void:
	var main_gd_script: Resource = load("res://main.gd")
	assert_true(main_gd_script != null,
			"res://main.gd must parse and load — a parse error here breaks the deployed page on script reload.")
