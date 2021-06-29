# 持久化

redis的数据是保存在内存中的，当redisServer关闭时，内存会被释放，再重启时这些保存在内存中的数据便丢失了，因此redis为了这些内存在server重启的时候不会丢失，提供了持久化功能，rdb与aof



# RDB

rdb是快照方式，保存server某一个时间点的数据，复原则利用这个数据备份直接复原



## RDB的触发

### 主动触发

在客户端中执行bgsave命令主动生成快照

```shell
127.0.0.1:6379> bgsave
Background saving started
```



**那么bgsave是怎么执行的**

* **bgsaveCommand**
  * 当前正在生成rdb、aof，则报错返回

  * **rdbPopulateSaveInfo** 获取执行rdb的实例是master还是slave的信息

  * **rdbSaveBackground**

    * **openChildInfoPipe** 

      创建管道，方便后面的父子进程间通信

    * **fork()**

      * 子进程
        * **closeClildUnusedResourceAfterFork** 子进程复制了父进程所有资源，这里关闭子进程不需要的资源
        * **redisSetProcTitle**
        * **rdbSaveRio** 将数据保存到临时文件
          * rdbSaveInfoAuxFields 保存redis-version、占用内存等信息
          * rdbSaveModulesAux 保存module数据
          * 遍历各个db，保存数据
          * 保存lua脚本
        * 将临时文件名称修改为server.rdb_filename所配置的文件名
        * 更新完毕后通过write()将相关信息写入server.child_info_pipe(保存子进程信息的管道)
        * 关闭子进程
      * 主进程，更新server中与rdb生成状态有关的字段

### 被动触发

除了主动触发外，可以通过在配置中填入

```shell
save 60 1000
```

设置server在60秒内超过1000个key发生修改时则生成快照

被动触发是依赖server的定时任务

* serverCron
  * 判断变化的key是否大于配置
  * 当前时间减去上次保存时间是否大于配置 
  * 当前时间减去上次尝试执行bgsave的时间是否大于间隔(5ms)
  * 上次执行bgsave是否成功
* rdbSaveBackground



# AOF

保存服务端执行过的每一条命令，复原需要模拟客户端对这些命令按顺序逐条执行



## AOF的触发

redis主线程每个循环都会遍历需要处理的客户端，在执行指令前判断是否开启了aof，是则将指令写入server.aof_buf(aof缓冲区)，处理完这个循环内所有的客户端后，调用flushAppendOnlyFile()，使用write()将server.aof_buffer写入server.aof_fd(aof文件描述符)，此时数据并未写入磁盘，而是保存在内核的缓冲区，需要调用fsync()函数来将数据写入磁盘

fsync是个阻塞且缓慢的操作，因此提供了3种策略选择

* no - 不执行fsync，靠操作系统刷盘保存，性能高、安全性差；
* always - 每次写入fd后一同执行fsync，性能差、安全性高；
* everysec - 每秒执行一次fsync，性能与安全的折中，默认方案



**将aof写入server.aof_buf代码路径如下

* **processCommand** 执行对应的指令

  * call

    * propagate

      * server.aof_state != AOF_OFF // 判断是否开启了AOF

        * 是则执行**feedAppendOnlyFile**

          将指令写入server.aof_buf



## AOF重写

随着redis服务的运行，AOF文件会越来越大，并且同一个键可能发生多次修改，同个键有多个AOF记录，最终导致AOF文件过大，恢复困难

例如：重写之前的指令为

```shell
127.0.0.1:6379> rpush list 1
(integer) 1
127.0.0.1:6379> rpush list 2
(integer) 2
127.0.0.1:6379> lpop list
"1"
```

重写之后便会变成

```shell
rpush list 2
```



### AOF重写的触发

#### 主动触发

客户端输入bgrewriteaof



顺利执行的顺序如下

* **bgrewriteaofCommand**

  * if 正在执行aof重写，返回

  * if 正在生成rdb，返回

  * **rewriteAppendOnlyFileBackground**

    * **aofCreatePipes、openChildInfoPipe**

      aof重写是fork()一个子进程出来，子进程执行完毕后，父进程需要接受子进程执行的结果，因此需要创建管道来接受子进程信息，管道地址保存在sever实例的字段上

    * **fork()**

      * 子进程
        * **closeClildUnusedResourceAfterFork** 子进程复制了父进程所有资源，这里关闭子进程不需要的资源
        * **redisSetProcTitle("redis-aof-rewrite")** 设置进程名
        * **rewriteAppendOnlyFile** 
          * 打开临时文件
          * 创建并初始化临时文件的输入输出流
          * 流设置是否需要自动同步到磁盘(如果配置需要的话，每达到32M自动同步到磁盘)
            * 如果开启了aof与rdb混合持久化，则执行**rdbSaveRio**
            * 如果没开启混合持久化模式，则执行**rewriteAppendOnlyFileRio** 传入流，开始重写
              * 遍历db
                * 遍历字典
                  * 根据key的类型执行对应的写入操作
                  * 存在过期时间的key则写入key的过期时间 
                  * 流写入的字节数每超过 10K，则执行**aofReadDiffFromParent** 通过管道获取父进程新的执行命令
          * 清空输入输出流(没有关闭)
          * 将文件同步到磁盘
          * **aofReadDiffFromParent**
          * 告知父进程停止发送新的aof，并确认父进程停止发送
          * **aofReadDiffFromParent** 再请求一次，确保获取所有该保存的命令
          * 将新的命令写入流中
          * 再清空流、同步文件、关闭文件
          * 将临时文件重命名为目的文件，替换原来的aof
        * **sendChildInfo** 返回个1给父进程，告知完成
        * 结束子进程
      * 父进程
        * **updateDictResizePolicy** 
          * **dictEnableResize** 停止字典进行扩容、所容，避免在执行rdb或aof的时候产生大量内存迁移



#### 被动触发

通过配置

```yaml
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
```

当aof文件超过64mb，且比基准大小大了100%时触发aof重写

基准为上次执行aof产生的aof文件大小



被动触发依赖redis的定时任务实现

* **serverCron**
  * 开启aof & 当前没有执行rdb & 当前没有执行aof & aof_rewrite_perc & 当前aof文件超过auto-aof-rewrite-min-size
  * **rewriteAppendOnlyFileBackground** 



# RDB与AOF混合持久化方案

**redis崩溃时，单使用RDB会产生数据丢失**

RDB保存的是整个redis的数据，因此每次执行空间与时间上都有很大的开销，因此不能时刻生成rdb快照，需要一个合适的时间间隔，那么当redis这个间隔中崩溃时，未生成快照的数据便丢失了

**高频的客户端请求或redis长时间运行导致AOF恢复数据困难**

AOF每次执行保存的是一个指令，时间空间消耗很小，可以时刻保存，在崩溃时即使丢失最多也只是丢失一条指令，但随着redis服务器运行产生大量的AOF记录，aof文件逐渐变大，恢复起来困难。



同时使用RDB、AOF，在服务器崩溃、恢复数据时，便可以通过先利用RDB恢复、再使用AOF恢复的方法，来保证至多丢失1条命令，减少数据复原耗时

开启配置

```
aof-use-rdb-preamble yes
```



**那么AOF+AOF重写是否可以代替RDB+AOF?**

aof重写后避免了aof文件过大的问题，rdb以数据复制的方式还原数据，aof以模拟执行指令的方式还原数据，还原数据的速度比的话，rdb比aof更快，因此最优方式还是rdb+aof

但假设这点还原速度差距可以忽略，感觉AOF+AOF还原也完全可以实现持久化

另外从rewriteAppendOnlyFileBackground函数中可以看到aof重写与aof、rdb混合模式是二选一执行的，就感觉...ojbk