# 根据表结构差异生成更新SQL

项目多次迭代后，新的版本与线上版本的表结构会产生较大差异，通过git版本差异比对再编写alter语句比较费时，且容易出错



## 使用mysql-utilities的mysqldbcompare

* 安装mysql-utilities
  * github地址 https://github.com/mysql/mysql-utilities
  
  * python2.7以上
  
  * 安装
  
    ```shell
    python ./setup.py build
    python ./setyp.py install
    ```
  
* 建立两个版本的db，以old、new为例，分别保存两个版本的表结构

* 比较new与old的差异，生成更新old的SQL，保存到update.sql

  ```shell
  mysqldbcompare --server1=root:123456@127.0.0.1:3306 --server2=root:123456@127.0.0.1:3306 old:new --run-all-tests --changes-for=server1 --difftype=sql > update.sql
  ```

* 在更新目标db中执行update.sql
