#pragma once

#include <Windows.h>
#include <Shlwapi.h>

#include <string>
#include <vector>

#define DEFAULT_BASE_KEY        HKEY_CURRENT_USER
#define DEFAULT_REGISTRY_KEY    "Software\\BERT2"

#define PATH_PATH_SEPARATOR ";"

namespace APIFunctions {

  /** reads resource in this dll */
  std::string ReadResource(LPTSTR resource_id);

  /** get the path of the current module (not containing process) */
  std::string ModulePath();

  typedef enum {
    Success = 0,
    FileNotFound = 1,
    FileReadError = 2
  } 
  FileError;

  /** 
   * list directory. returns a tuple of filename, last write. lists files only, 
   * not directories. the return value is the _full_path_, including the directory.
   *
   * TODO: options?
   */
  std::vector<std::pair<std::string, FILETIME>> ListDirectory(const std::string &directory);

  /** reads registry string */
  bool GetRegistryString(std::string &result_value, const char *name, const char *key = 0, HKEY base_key = 0);

  /** reads registry dword */
  bool GetRegistryDWORD(DWORD &result_value, const char *name, const char *key = 0, HKEY base_key = 0);

  /** gets path. we are caching before modifying */
  std::string GetPath();

  /** appends given string to path. returns new path. */
  std::string AppendPath(const std::string &new_path);

  /** prepends given string to path. returns new path. */
  std::string PrependPath(const std::string &new_path);

  /** sets path (for uncaching) */
  void SetPath(const std::string &path);

  /** read a file and return contents */
  FileError FileContents(std::string &contents, const std::string &path);

};