using System;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class TrainingNativeSpeech {
  public static void Run(string url, string[] names, string[] values, string[] messages, string destination) {
    RunAsync(url,names,values,messages,destination).GetAwaiter().GetResult();
  }
  private static async Task RunAsync(string url, string[] names, string[] values, string[] messages, string destination) {
    using (var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(45)))
    using (var socket = new ClientWebSocket())
    using (var audio = new MemoryStream()) {
      for(int i=0;i<names.Length;i++) {
        if(names[i].Equals("Sec-WebSocket-Version",StringComparison.OrdinalIgnoreCase) || names[i].Equals("Accept-Encoding",StringComparison.OrdinalIgnoreCase)) continue;
        socket.Options.SetRequestHeader(names[i],values[i]);
      }
      await socket.ConnectAsync(new Uri(url),cancel.Token);
      foreach(var message in messages) {
        var bytes=Encoding.UTF8.GetBytes(message);
        await socket.SendAsync(new ArraySegment<byte>(bytes),WebSocketMessageType.Text,true,cancel.Token);
      }
      bool ended=false;
      while(!ended) {
        using(var message = new MemoryStream()) {
          var buffer=new byte[65536];
          WebSocketReceiveResult read;
          do {
            read=await socket.ReceiveAsync(new ArraySegment<byte>(buffer),cancel.Token);
            if(read.MessageType==WebSocketMessageType.Close) throw new IOException("Speech socket closed before complete utterance");
            message.Write(buffer,0,read.Count);
          } while(!read.EndOfMessage);
          var bytes=message.ToArray();
          if(read.MessageType==WebSocketMessageType.Text) {
            var text=Encoding.UTF8.GetString(bytes);
            if(text.Contains("Path:turn.end")) ended=true;
          } else {
            if(bytes.Length<2) throw new IOException("Invalid speech audio message");
            int header=bytes[0]*256+bytes[1];
            if(header+2>bytes.Length) throw new IOException("Invalid speech audio header");
            string headers=Encoding.UTF8.GetString(bytes,2,header);
            if(!headers.Contains("Path:audio")) throw new IOException("Unexpected speech binary path");
            int count=bytes.Length-header-2;
            if(count>0) audio.Write(bytes,header+2,count);
          }
        }
      }
      if(audio.Length<1000) throw new IOException("Speech service returned no complete audio");
      File.WriteAllBytes(destination,audio.ToArray());
      socket.Abort();
    }
  }
}
