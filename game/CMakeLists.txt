dreamcomp_add_port(bomberman_online
  TITLE "Bomberman Online"
  OUTPUT_NAME bomberman-online
  SOURCES ${PROJECT_SOURCE_DIR}/src/bomberman_online.cpp)

# The generated unit is ~179 MB of C++, emitted as eight translation units so it compiles in
# parallel. During config discovery the edit-build-run loop matters more than guest speed, so an
# opt-in -O0 build shortens each iteration; release builds keep the framework's -O1. Reconfigure
# with -DBMO_FAST_BUILD=ON.
option(BMO_FAST_BUILD "Compile the generated SH-4 units at -O0 (config discovery only)" OFF)
if(BMO_FAST_BUILD AND TARGET bomberman_online_boot)
  file(GLOB _bmo_units ${CMAKE_CURRENT_BINARY_DIR}/gen/bomberman_online_part*.cpp)
  if(_bmo_units)
    set_source_files_properties(${_bmo_units} PROPERTIES COMPILE_OPTIONS "-O0")
  endif()
  message(STATUS "bomberman_online: BMO_FAST_BUILD=ON (generated units at -O0)")
endif()
