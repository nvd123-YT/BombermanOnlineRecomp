# Copy runtime DLLs next to a Windows executable when there are any.
# Static-only builds legitimately provide an empty TARGET_RUNTIME_DLLS list.

if(NOT DEFINED RUNTIME_DLLS OR RUNTIME_DLLS STREQUAL "")
  return()
endif()

if(NOT DEFINED OUTPUT_DIR OR NOT IS_DIRECTORY "${OUTPUT_DIR}")
  message(FATAL_ERROR "Runtime DLL output directory does not exist: '${OUTPUT_DIR}'")
endif()

foreach(_dll IN LISTS RUNTIME_DLLS)
  if(NOT EXISTS "${_dll}")
    message(FATAL_ERROR "Runtime DLL does not exist: '${_dll}'")
  endif()
  get_filename_component(_name "${_dll}" NAME)
  file(COPY_FILE "${_dll}" "${OUTPUT_DIR}/${_name}" ONLY_IF_DIFFERENT)
endforeach()
