# redis到底是不是单线程

以前背八股文的时候，经常看到这么介绍redis

​	数据保存在内存，是个单线程，速度很快，性能甩mysql几条街

后来又看到说不是的，所以它到底是啥



# redis-server是怎么跑起来的

从server.c文件找到main函数

* **main(int argc, char \*\*argv)**

  ​	argv是个字符串数组，保存了启动指令携带的参数，例如输入:

  ```
  redis-server -v
  Redis server v=5.0.12 sha=265341b5:0 malloc=jemalloc-5.1.0 bits=64 build=c287ec797ecae670
  ```

  ​	那么argv便为["redis-server", -v"]

  ​	argc为数组的长度

  * **spt_init** 

    spt初始化，执行后才能调用**setproctitle**来为子进程命名

  * **initServerConfig** 

    对全局变量server进行初始化(基本所有数据都保存在server内，字段都有好几百个)

    例如:

    * 配置文件地址，是否开启aof等，初始化时大部分为null或者false，会在后面加载完配置文件后修改为配置值
    * 命令字典，get，set，hget等命令是以一个字典的形式保存在server.commands指针字段中，甚至对于del，expire这些使用频率高的命令，直接开个server.delCommand指针字段保存，节省去字典找的步骤

  * **模块系统初始化**

  * **处理非启动server的指令**

    假设指令是redis-server -v|--help这些的话，直接打印对应的数据，然后结束进程

  * **读取指令中的配置文件地址**

  * **读取指令中配置文件地址后面的启动配置**

    例如: --port，--loglevel等

  * **loadServerConfig** 

    从配置文件加载配置

  * **是否以后台的方式启动**

    是则fork()出一个子进程，结束父进程，子进程被init进程领养，作为守护进程在后台运行

  * **initServer**

    * 保存进程id
    * 创建空的客户端实例双向链表、当前执行命令的客户端设为空、
    * 创建空的monitors链表(redis大部分都是使用双向链表)
    * 创建共享数据对象(1-10000，当我们保存值为这个范围内时，不会创建新的robj对象保存数据，直接使用这些共享数据，这些数据没有过期时间，且永远不会被lru策略淘汰)
    * 初始化主线程循环所要用到的参数，保存进server.el中
    * 分配db空间(默认16个)
    * 监听端口、将socket设为非阻塞
    * 为16个db创建数据字典、过期时间字典等
    * 又是对一堆字段设置初始值
    * 通过**aeCreateTimeEvent**创建定时任务**serverCron**
    * 通过**aeCreateFileEvent**监听socket(接受到客户端请求时会触发一个文件事件)
    * 如果开启了aof则打开aof文件
    * ...

  *  **redisSetProcTitle(argv[0]);**

    设置进程名为argv[0]，即redis-server

  *  **checkTcpBacklogSettings();** 检查TCP队列长度

  * **moduleLoadFromQueue**

    模块加载

  * **InitServerLast**

    * **bioInit** 

      bio初始化，bio提供了一个线程，用与执行后台任务，例如: server.aof_buf同步到磁盘，write()写进文件描述符号后，fsync()操作是在后台任务执行的(server.aof_fsync默认everysec，每秒fsync一次)

    * 再更新下server完成初始化使用的内存

  * **loadDataFromDisk**

    从磁盘加载数据，根据配置决定是使用rdb加载还是aof加载

  *  **aeSetBeforeSleepProc(server.el,beforeSleep)**

    这里是将一个beforeSleep函数的地址保存到server.el.beforeSleep中

  *  **aeSetAfterSleepProc(server.el,afterSleep);**

    将afterSleep函数地址保存到server.el.afterSleep中

  * **aeMain**

    ```c
    void aeMain(aeEventLoop *eventLoop) {
        eventLoop->stop = 0;
        while (!eventLoop->stop) {
            if (eventLoop->beforesleep != NULL)
                eventLoop->beforesleep(eventLoop);
            aeProcessEvents(eventLoop, AE_ALL_EVENTS|AE_CALL_AFTER_SLEEP);
        }
    }
    ```

    跑到这里，是一个无限循环代码，这是redisServer开始了他的工作： 监听客户端请求、执行、响应

    * beforesleep
      * 
    * **aeProcessEvents**
      * 