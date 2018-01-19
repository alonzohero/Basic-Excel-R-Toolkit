
#include "include_common.h"
#include "control_julia.h"
#include "julia_interface.h"
#include "pipe.h"

#include <stdlib.h>
#include <stdio.h>
#include <io.h>
#include <fcntl.h>
#include <process.h>

#include <fstream>

std::vector<Pipe*> pipes;
std::vector<HANDLE> handles;
std::vector<std::string> console_buffer;

std::string pipename;
int console_client = -1;

HANDLE prompt_event_handle;

//std::ofstream console_out;
//std::ofstream console_err;

/** debug/util function */
void DumpJSON(const google::protobuf::Message &message, const char *path = 0) {
  std::string str;
  google::protobuf::util::JsonOptions opts;
  opts.add_whitespace = true;
  google::protobuf::util::MessageToJsonString(message, &str, opts);
  if (path) {
    FILE *f;
    fopen_s(&f, path, "w");
    if (f) {
      fwrite(str.c_str(), sizeof(char), str.length(), f);
      fflush(f);
    }
    fclose(f);
  }
  else std::cout << str << std::endl;
}

void NextPipeInstance(bool block, std::string &name) {
  Pipe *pipe = new Pipe;
  int rslt = pipe->Start(name, block);
  handles.push_back(pipe->wait_handle_read());
  handles.push_back(pipe->wait_handle_write());
  pipes.push_back(pipe);
}

void CloseClient(int index) {

  /*
  // shutdown if primary client breaks connection
  if (index == PRIMARY_CLIENT_INDEX) Shutdown(-1);

  // callback shouldn't close either
  else if (index == CALLBACK_INDEX) {
    cerr << "callback pipe closed" << endl;
    // Shutdown(-1);
  }

  // otherwise clean up, and watch out for console
  else
  */
  {
    pipes[index]->Reset();
    if (index == console_client) {
      console_client = -1;
    }
  }

}

// FIXME: utility library
std::string GetLastErrorAsString(DWORD err = -1)
{
  //Get the error message, if any.
  DWORD errorMessageID = err;
  if (-1 == err) errorMessageID = ::GetLastError();
  if (errorMessageID == 0)
    return std::string(); //No error message has been recorded

  LPSTR messageBuffer = nullptr;
  size_t size = FormatMessageA(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
    NULL, errorMessageID, MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT), (LPSTR)&messageBuffer, 0, NULL);

  std::string message(messageBuffer, size);

  //Free the buffer.
  LocalFree(messageBuffer);

  return message;
}


/**
* frame message and push to console client, or to queue if
* no console client is connected
*/
void PushConsoleMessage(google::protobuf::Message &message) {
  std::string framed = MessageUtilities::Frame(message);
  if (console_client >= 0) {
    pipes[console_client]->PushWrite(framed);
  }
  else {
    console_buffer.push_back(framed);
  }
}

void PushConsoleString(const std::string &str) {
  if (console_client >= 0) {
    pipes[console_client]->PushWrite(str);
  }
  else {
    console_buffer.push_back(str);
  }
}

void ConsoleMessage(const char *buf, int len, int flag) {
  BERTBuffers::CallResponse message;
  if (flag) message.mutable_console()->set_err(buf, len);
  else message.mutable_console()->set_text(buf, len);
  PushConsoleMessage(message);
}

std::string prompt_string;

void ConsolePrompt(const char *prompt, uint32_t id) {
  BERTBuffers::CallResponse message;
  message.set_id(id);
  message.mutable_console()->set_prompt(prompt);
  prompt_string = MessageUtilities::Frame(message);
  SetEvent(prompt_event_handle);
}

/**
 * in an effort to make the core language agnostic, all actual functions are moved
 * here. this should cover things like initialization and setting the COM pointers.
 *
 * the caller uses symbolic constants that call these functions in the appropriate
 * language.
 */
void SystemCall(BERTBuffers::CallResponse &response, const BERTBuffers::CallResponse &call) {
  std::string function = call.function_call().function();

  /*
  BERTBuffers::CallResponse translated_call;
  translated_call.CopyFrom(call);

  if (!function.compare("install-application-pointer")) {
    translated_call.mutable_function_call()->set_target(BERTBuffers::CallTarget::language);
    translated_call.mutable_function_call()->set_function("BERT$install.application.pointer");
    RCall(response, translated_call);
  }
  else */
  if (!function.compare("get-language")) {
    response.mutable_result()->set_str("Julia");
  }
  else if (!function.compare("read-source-file")) {
    std::string file = call.function_call().arguments(0).str();
    bool success = false;
    if (file.length()) {
      std::cout << "read source: " << file << std::endl;
      success = ReadSourceFile(file);
    }
    response.mutable_result()->set_boolean(success);
  }
  else {
    std::cout << "ENOTIMPL (system): " << function << std::endl;
    response.mutable_result()->set_boolean(false);
  }

}

void pipe_loop() {

  char prompt[] = "julia> ";

  DWORD result, len;
  uint32_t console_prompt_id = 1;
  std::string message;

  ConsolePrompt(prompt, console_prompt_id++);

  while (true) {

    result = WaitForMultipleObjects((DWORD)handles.size(), &(handles[0]), FALSE, 100);

    if (result >= WAIT_OBJECT_0 && result - WAIT_OBJECT_0 < 16) {

      int offset = (result - WAIT_OBJECT_0);
      int index = offset / 2;
      bool write = offset % 2;
      auto pipe = pipes[index];

      //if (!index) std::cout << "pipe event on index 0 (" << (write ? "write" : "read") << ")" << std::endl;

      ResetEvent(handles[result - WAIT_OBJECT_0]);

      if (!pipe->connected()) {
        std::cout << "connect (" << index << ")" << std::endl;
        pipe->Connect(); // this will start reading
        if (pipes.size() < MAX_PIPE_COUNT) NextPipeInstance(false, pipename);
      }
      else if (write) {
        pipe->NextWrite();
      }
      else {
        result = pipe->Read(message);
        if (!result) {

          BERTBuffers::CallResponse call, response;
          bool success = MessageUtilities::Unframe(call, message);

          if (success) {

            //std::cout << "success" << std::endl;
            response.set_id(call.id());
            //DumpJSON(call);

            switch (call.operation_case()) {

            case BERTBuffers::CallResponse::kFunctionCall:

              //std::cout << "function call" << std::endl;
              switch (call.function_call().target()) {
              case BERTBuffers::CallTarget::system:
                SystemCall(response, call);
                break;
              default:
                JuliaCall(response, call);
                break;
              }
              if (call.wait()) pipe->PushWrite(MessageUtilities::Frame(response));
              break;

            case BERTBuffers::CallResponse::kCode:
              // std::cout << "code" << std::endl;
              JuliaExec(response, call);
              if (call.wait()) pipe->PushWrite(MessageUtilities::Frame(response));
              break;

            case BERTBuffers::CallResponse::kShellCommand:
              std::cout << "shell command" << std::endl;
              julia_exec_command(call.shell_command());
              // if (call.wait()) pipe->PushWrite(MessageUtilities::Frame(response));
              console_prompt_id = call.id();
              ConsolePrompt(prompt, console_prompt_id);
              break;

            case BERTBuffers::CallResponse::kControlMessage:
            {
              std::string command = call.control_message();
              std::cout << "system command: " << command << std::endl;
              if (!command.compare("shutdown")) {
                //ConsoleControlMessage("shutdown");
                //Shutdown(0);
                return; // exit
              }
              else if (!command.compare("console")) {
                if (console_client < 0) {
                  console_client = index;
                  std::cout << "set console client -> " << index << std::endl;
                  pipe->QueueWrites(console_buffer);
                  console_buffer.clear();
                }
                else std::cerr << "console client already set" << std::endl;
              }
              else if (!command.compare("close")) {
                CloseClient(index);
                break; // no response 
              }
              else {
                // ...
              }

              if (call.wait()) {
                response.set_id(call.id());
                //pipe->PushWrite(rsp.SerializeAsString());
                pipe->PushWrite(MessageUtilities::Frame(response));
              }
              else pipe->NextWrite();
            }
            break;

            default:
              // ...
              0;
            }

            /*
            if (call_depth == 0 && recursive_calls) {
              cout << "unwind recursive prompt stack" << endl;
              recursive_calls = false;
              ConsoleResetPrompt(prompt_transaction_id);
            }
            */

          }
          else {
            if (pipe->error()) {
              std::cout << "ERR in system pipe: " << result << std::endl;
            }
            else std::cerr << "error parsing packet: " << result << std::endl;
          }
          if (pipe->connected() && !pipe->reading()) {
            pipe->StartRead();
          }

        }
        else {
          if (result == ERROR_BROKEN_PIPE) {
            std::cerr << "broken pipe (" << index << ")" << std::endl;
            CloseClient(index);
          }
          //else if (result == ERROR_MORE_DATA) {
          //    cout << "(more data...)" << endl;
          //}
        }
      }
    }
    else if (result == WAIT_TIMEOUT) {
      // ...
    }
    else {
      std::cerr << "ERR " << result << ": " << GetLastErrorAsString(result) << std::endl;
      break;
    }
  }

}


unsigned __stdcall StdioThreadFunction(void *data) {

  //Pipe *pipe = (Pipe*)data;
  Pipe **pipes = (Pipe**)data;
  std::string str;

  HANDLE handles[] = { prompt_event_handle, pipes[0]->wait_handle_read(), pipes[1]->wait_handle_read() };

  while (true) {
    //DWORD wait_result = WaitForSingleObjectEx(handle, 1000, 0);
    DWORD wait_result = WaitForMultipleObjects(3, handles, FALSE, 1000);
    if (wait_result == WAIT_OBJECT_0) {
      ResetEvent(prompt_event_handle);
      PushConsoleString(prompt_string);
    }
    else if(wait_result == WAIT_OBJECT_0 + 1){
      ResetEvent(pipes[0]->wait_handle_read());
      if (!pipes[0]->connected()) {
        pipes[0]->Connect();
      }
      else {
        pipes[0]->Read(str, false);
        std::cout << "|| " << str << std::endl;
        ConsoleMessage(str.c_str(), str.length(), 0);
        pipes[0]->StartRead();
      }
    }
    else if (wait_result == WAIT_OBJECT_0 + 2) {
      ResetEvent(pipes[1]->wait_handle_read());
      if (!pipes[1]->connected()) {
        pipes[1]->Connect();
      }
      else {
        pipes[1]->Read(str, false);
        std::cerr << "|| " << str << std::endl;
        ConsoleMessage(str.c_str(), str.length(), 1);
        pipes[1]->StartRead();
      }
    }
    else if (wait_result == WAIT_TIMEOUT) {
      // std::cerr << "timeout" << std::endl;
    }
    else {
      std::cerr << "ERR in wait: " << GetLastError() << std::endl;
    }
  }

  return 0;
}

int main(int argc, char **argv) {

  for (int i = 0; i < argc; i++) {
    if (!strncmp(argv[i], "-p", 2) && i < argc - 1) {
      pipename = argv[++i];
    }
  }

  if (!pipename.length()) {
    std::cerr << "call with -p pipename" << std::endl;
    return -1;
  }

  std::cout << "pipe: " << pipename << std::endl;

  // for julia, contra R, we are capturing stdio (out and err) 
  // to send to a console client. because writes can happen while
  // we're blocked, we'll need a separate thread to handle stdio 
  // writes.

  // attach cout back to the console for debug/tracing

  // FIXME: is it necessary to duplicate this handle? 

  /*
  int console_stdout = 0;
  _dup2(1, console_stdout);
  std::ofstream console_out(_fdopen(console_stdout, "w")); // NOTE this is nonstandard

  int console_stderr = 0;
  _dup2(2, console_stderr);
  std::ofstream console_err(_fdopen(console_stderr, "w")); 

  prompt_event_handle = CreateEvent(0, TRUE, FALSE, 0);

  Pipe *stdio_pipes[] = { new Pipe, new Pipe };

  stdio_pipes[0]->Start("stdout", false);
  HANDLE stdio_write_handle = CreateFile(stdio_pipes[0]->full_name().c_str(), FILE_ALL_ACCESS, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);

  stdio_pipes[1]->Start("stderr", false);
  HANDLE stderr_write_handle = CreateFile(stdio_pipes[1]->full_name().c_str(), FILE_ALL_ACCESS, FILE_SHARE_READ | FILE_SHARE_WRITE, 0, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, 0);
  
  uintptr_t thread_handle = _beginthreadex(0, 0, StdioThreadFunction, stdio_pipes, 0, 0);

  _dup2(_open_osfhandle((intptr_t)stdio_write_handle, _O_TEXT), 1); // 1 is stdout
  _dup2(_open_osfhandle((intptr_t)stderr_write_handle, _O_TEXT), 2);

  std::cout.rdbuf(console_out.rdbuf());
  std::cerr.rdbuf(console_err.rdbuf());

//  char buffer[] = "ZRRBT\n";
//  DWORD bytes;
//  WriteFile(write_handle, buffer, strlen(buffer), &bytes, 0);
  */

  NextPipeInstance(true, pipename);

  std::cout << "first pipe connected" << std::endl;

  JuliaInit();

  pipe_loop();
  // julia_exec();

  JuliaShutdown();

  handles.clear();

  for (auto pipe : pipes) delete pipe;

  pipes.clear();

  return 0;

}
