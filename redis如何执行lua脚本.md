# redis如何执行lua脚本

## 什么是lua脚本

就是在redis里面执行lua代码



**eval**命令，直接执行lua脚本

```shell
127.0.0.1:6379> eval "return redis.call('get', KEYS[1])" 1 a
"1"
```



但当脚本很长的时候，每次都传脚本过去显然很耗带宽，于是还有个**evalsha**命令，先用script(脚本管理的命令) load命令将脚本保存的服务端，返回一个脚本sha1校验和

evalsha命令带上sha1校验和以及入参即可执行lua脚本

```shell
127.0.0.1:6379> script load "return redis.call('get', KEYS[1])"
"4e6d8fc8bb01276962cce5371fa795a7763657ae"
127.0.0.1:6379> evalsha 4e6d8fc8bb01276962cce5371fa795a7763657ae 1 a
"1"
```



## eval与evalsha是怎么执行的

eval命令的入口为evalCommand

* **evalCommand**

  * **evalGenericCommand(client *c, int evalsha)**

    这里有个evalsha参数，1代表执行evalsha命令，0代表执行eval命令

    * 初始化上次脚本执行后的状态
    * 命令参数校验
    * 使用eval则根据脚本生成一个sha1校验和
    * 使用evalsha则将sha1校验和转小写
    * 将sha1校验和放入server.lua中，server.lua是所有client共享的唯一的lua脚本解释器，可以根据sha1校验和查找对应的脚本(lua脚本的保存结构为哈希表+链表)
    * 如果lua脚本解释器没找到sha1校验和对应的脚本
      * evalsha1返回没找到脚本
      * eval创建脚本
    * 将参数传入lua脚本解释器
    * 将sever.lua_client的db参数与为发起lua脚本的client同步，lua_client为执行lua脚本的模拟客户端
    * 给lua脚本解析器设置监听器，添加超时回调，debug状态下添加行解析回调(解析一行脚本触发一次)
    * **lua_pcall** 执行lua脚本
    * 清空回调
    * 如果超时且是主服务器的话，将脚本放到非阻塞client链表的尾部，在下一个循环处理
    * 每执行50次lua脚本就会进行垃圾回收
    * 向客户端返回lua执行结果
    * 如果使用的是单命令复制、且lua脚本存在一个写操作，则发送exec给aof文件和从服务器
    * 假设使用evalsha，且sha1没有发送给从服务器(使用字典记录了sha1有没有发送给从服务器)，会被转为完成的eval命令发送给从服务器以及aof文件

